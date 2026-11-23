-- Phase 3, task 2: product and variant completeness.
--
-- Adds the catalog fields Phase 4 needs and Shopify's Admin API (2026-07) gives with the scopes held:
--  - products: description truncation, taxonomy category ID, option names, default-variant, selling-plan,
--    bundle and combined-listing flags, featured image metadata, media count and Online Store URL;
--  - variants: barcode, availability, bundle components, unit-price measurement, harmonized system
--    code and province of origin;
--  - products.fields_version: which field set a row was last read with (null: before this migration),
--    so a missing value read before 0044 is "not read", never "empty";
--  - variant metafields (owner_type 'variant', allowed since 0024) through ingest_catalog;
--  - metafield definitions (names and types of product and variant metafields) in a new table, and
--    metaobject definitions and the metaobjects products reference in the tables 0024 created;
--  - catalog_reference_ids lists referenced metaobjects that are missing or stale, read from
--    reference metafields' values (Shopify GIDs), with a small partial index;
--  - insight_products returns the new fields and variant metafields; insight_metaobjects resolves
--    references for the read path.
-- Existing rows are unchanged; new columns are null until the next catalog read.

alter table public.products
  add column fields_version          smallint check (fields_version > 0),
  add column description_truncated   boolean,
  add column category_id             text check (char_length(category_id) <= 64),
  add column option_names            text[] check (cardinality(option_names) <= 10),
  add column has_only_default_variant boolean,
  add column requires_selling_plan   boolean,
  add column is_bundle               boolean,
  add column combined_listing_role   text check (combined_listing_role in ('parent', 'child')),
  add column featured_image_url      text check (char_length(featured_image_url) <= 1024),
  add column featured_image_alt      text check (char_length(featured_image_alt) <= 512),
  add column featured_image_width    integer check (featured_image_width > 0),
  add column featured_image_height   integer check (featured_image_height > 0),
  add column media_count             integer check (media_count >= 0),
  add column online_store_url        text check (char_length(online_store_url) <= 1024);

alter table public.product_variants
  add column barcode                 text check (char_length(barcode) <= 255),
  add column available_for_sale      boolean,
  add column requires_components     boolean,
  add column unit_price_measurement  jsonb check (jsonb_typeof(unit_price_measurement) = 'object' and pg_column_size(unit_price_measurement) <= 512),
  add column harmonized_system_code  text check (char_length(harmonized_system_code) <= 32),
  add column province_of_origin      text check (char_length(province_of_origin) <= 16);

alter table public.metaobjects
  add column fields_truncated boolean not null default false;
-- The field whose value is a metaobject's display name (Shopify's displayNameKey).
alter table public.metaobject_definitions
  add column display_name_key text check (char_length(display_name_key) between 1 and 64);

-- Names and types of the shop's product and variant metafields: what a specification means.
create table public.metafield_definitions (
  shop_key     integer not null references public.shops (shop_key),
  owner_type   text not null check (owner_type in ('product', 'variant')),
  namespace    text not null check (char_length(namespace) between 1 and 255),
  key          text not null check (char_length(key) between 1 and 64),
  shopify_id   bigint not null check (shopify_id > 0),
  name         text not null check (char_length(name) between 1 and 255),
  type         text not null check (char_length(type) between 1 and 64),
  description  text check (char_length(description) <= 500),
  synced_at    timestamptz not null default now(),
  primary key (shop_key, owner_type, namespace, key)
);
alter table public.metafield_definitions enable row level security;
revoke all on table public.metafield_definitions from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.metafield_definitions to service_role;

-- Reference metafields only: what catalog_reference_ids scans.
create index metafields_references_idx on public.metafields (shop_key)
  where type ~ 'metaobject_reference|mixed_reference';

-- The catalog write (0032), with the fields above and variant metafields. Metafield rows name their
-- owner type (default 'product') and the product they belong to (product_shopify_id; a product's own
-- metafield defaults to its owner), so only rows of products this batch writes (newer wins) are
-- applied, and each written product's metafields, and its variants', are replaced.
create or replace function public.ingest_catalog(p_shop_key integer, p_products jsonb, p_variants jsonb, p_metafields jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_written bigint[];
  v_removed_variants bigint[];
  v_variants integer := 0;
  v_metafields integer := 0;
  v_metafields_removed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_products, p_variants, p_metafields) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  with incoming as (
    select * from jsonb_to_recordset(coalesce(p_products, '[]')) as x(
      shopify_id bigint, title text, handle text, status text, product_type text, vendor text, category text, tags text[],
      description_excerpt text, is_gift_card boolean, published_at timestamptz, shopify_created_at timestamptz, shopify_updated_at timestamptz,
      fields_version smallint, description_truncated boolean, category_id text, option_names text[], has_only_default_variant boolean,
      requires_selling_plan boolean, is_bundle boolean, combined_listing_role text, featured_image_url text, featured_image_alt text,
      featured_image_width integer, featured_image_height integer, media_count integer, online_store_url text)
  ), written as (
    insert into public.products as p (shop_key, shopify_id, title, handle, status, product_type, vendor, category, tags,
      description_excerpt, is_gift_card, published_at, shopify_created_at, shopify_updated_at, synced_at,
      fields_version, description_truncated, category_id, option_names, has_only_default_variant, requires_selling_plan, is_bundle,
      combined_listing_role, featured_image_url, featured_image_alt, featured_image_width, featured_image_height, media_count, online_store_url)
    select p_shop_key, shopify_id, title, handle, status, product_type, vendor, category, coalesce(tags, '{}'),
           description_excerpt, coalesce(is_gift_card, false), published_at, shopify_created_at, shopify_updated_at, now(),
           fields_version, description_truncated, category_id, option_names, has_only_default_variant, requires_selling_plan, is_bundle,
           combined_listing_role, featured_image_url, featured_image_alt, featured_image_width, featured_image_height, media_count, online_store_url
      from incoming
    on conflict (shop_key, shopify_id) do update set
      title = excluded.title, handle = excluded.handle, status = excluded.status, product_type = excluded.product_type,
      vendor = excluded.vendor, category = excluded.category, tags = excluded.tags, description_excerpt = excluded.description_excerpt,
      is_gift_card = excluded.is_gift_card, published_at = excluded.published_at, shopify_created_at = excluded.shopify_created_at,
      shopify_updated_at = excluded.shopify_updated_at, synced_at = now(),
      fields_version = excluded.fields_version, description_truncated = excluded.description_truncated, category_id = excluded.category_id,
      option_names = excluded.option_names, has_only_default_variant = excluded.has_only_default_variant,
      requires_selling_plan = excluded.requires_selling_plan, is_bundle = excluded.is_bundle, combined_listing_role = excluded.combined_listing_role,
      featured_image_url = excluded.featured_image_url, featured_image_alt = excluded.featured_image_alt,
      featured_image_width = excluded.featured_image_width, featured_image_height = excluded.featured_image_height,
      media_count = excluded.media_count, online_store_url = excluded.online_store_url
     where p.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= p.shopify_updated_at
    returning p.shopify_id
  )
  select coalesce(array_agg(shopify_id), '{}') into v_written from written;

  insert into public.product_variants as v (shop_key, shopify_id, product_shopify_id, title, sku, position, selected_options, price,
    compare_at_price, taxable, inventory_item_id, tracked, inventory_policy, inventory_quantity, requires_shipping, weight, weight_unit,
    unit_cost, unit_cost_currency, country_of_origin, shopify_created_at, shopify_updated_at, synced_at,
    barcode, available_for_sale, requires_components, unit_price_measurement, harmonized_system_code, province_of_origin)
  select p_shop_key, x.shopify_id, x.product_shopify_id, x.title, x.sku, x.position, coalesce(x.selected_options, '[]'), x.price,
         x.compare_at_price, x.taxable, x.inventory_item_id, x.tracked, x.inventory_policy, x.inventory_quantity, x.requires_shipping,
         x.weight, x.weight_unit, x.unit_cost, x.unit_cost_currency, x.country_of_origin, x.shopify_created_at, x.shopify_updated_at, now(),
         x.barcode, x.available_for_sale, x.requires_components, x.unit_price_measurement, x.harmonized_system_code, x.province_of_origin
    from jsonb_to_recordset(coalesce(p_variants, '[]')) as x(
      shopify_id bigint, product_shopify_id bigint, title text, sku text, position integer, selected_options jsonb, price numeric,
      compare_at_price numeric, taxable boolean, inventory_item_id bigint, tracked boolean, inventory_policy text, inventory_quantity integer,
      requires_shipping boolean, weight numeric, weight_unit text, unit_cost numeric, unit_cost_currency text, country_of_origin text,
      shopify_created_at timestamptz, shopify_updated_at timestamptz, barcode text, available_for_sale boolean, requires_components boolean,
      unit_price_measurement jsonb, harmonized_system_code text, province_of_origin text)
   where x.product_shopify_id = any (v_written)
  on conflict (shop_key, shopify_id) do update set
    product_shopify_id = excluded.product_shopify_id, title = excluded.title, sku = excluded.sku, position = excluded.position,
    selected_options = excluded.selected_options, price = excluded.price, compare_at_price = excluded.compare_at_price,
    taxable = excluded.taxable, inventory_item_id = excluded.inventory_item_id, tracked = excluded.tracked,
    inventory_policy = excluded.inventory_policy, inventory_quantity = excluded.inventory_quantity,
    requires_shipping = excluded.requires_shipping, weight = excluded.weight, weight_unit = excluded.weight_unit,
    unit_cost = excluded.unit_cost, unit_cost_currency = excluded.unit_cost_currency, country_of_origin = excluded.country_of_origin,
    shopify_created_at = excluded.shopify_created_at, shopify_updated_at = excluded.shopify_updated_at, synced_at = now(),
    barcode = excluded.barcode, available_for_sale = excluded.available_for_sale, requires_components = excluded.requires_components,
    unit_price_measurement = excluded.unit_price_measurement, harmonized_system_code = excluded.harmonized_system_code,
    province_of_origin = excluded.province_of_origin
   where v.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= v.shopify_updated_at;
  get diagnostics v_variants = row_count;

  with removed as (
    delete from public.product_variants v
     where v.shop_key = p_shop_key and v.product_shopify_id = any (v_written)
       and not exists (select 1 from jsonb_to_recordset(coalesce(p_variants, '[]')) as x(shopify_id bigint) where x.shopify_id = v.shopify_id)
    returning v.shopify_id
  )
  select coalesce(array_agg(shopify_id), '{}') into v_removed_variants from removed;

  -- A written product's metafields, and its variants', are exactly those in the batch.
  delete from public.metafields m
   where m.shop_key = p_shop_key
     and ((m.owner_type = 'product' and m.owner_shopify_id = any (v_written))
          or (m.owner_type = 'variant' and (m.owner_shopify_id = any (v_removed_variants)
              or m.owner_shopify_id in (select x.shopify_id from jsonb_to_recordset(coalesce(p_variants, '[]')) as x(shopify_id bigint, product_shopify_id bigint)
                                         where x.product_shopify_id = any (v_written)))))
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_metafields, '[]')) as x(owner_type text, owner_shopify_id bigint, product_shopify_id bigint, namespace text, key text)
                      where coalesce(x.owner_type, 'product') = m.owner_type and x.owner_shopify_id = m.owner_shopify_id
                        and x.namespace = m.namespace and x.key = m.key
                        and coalesce(x.product_shopify_id, case when coalesce(x.owner_type, 'product') = 'product' then x.owner_shopify_id end) = any (v_written));
  get diagnostics v_metafields_removed = row_count;

  insert into public.metafields as m (shop_key, owner_type, owner_shopify_id, namespace, key, type, value_excerpt, value_truncated, shopify_updated_at, synced_at)
  select p_shop_key, coalesce(x.owner_type, 'product'), x.owner_shopify_id, x.namespace, x.key, x.type, x.value_excerpt,
         coalesce(x.value_truncated, false), x.shopify_updated_at, now()
    from jsonb_to_recordset(coalesce(p_metafields, '[]')) as x(owner_type text, owner_shopify_id bigint, product_shopify_id bigint, namespace text,
         key text, type text, value_excerpt text, value_truncated boolean, shopify_updated_at timestamptz)
   where coalesce(x.product_shopify_id, case when coalesce(x.owner_type, 'product') = 'product' then x.owner_shopify_id end) = any (v_written)
  on conflict (shop_key, owner_type, owner_shopify_id, namespace, key) do update set
    type = excluded.type, value_excerpt = excluded.value_excerpt, value_truncated = excluded.value_truncated,
    shopify_updated_at = excluded.shopify_updated_at, synced_at = now();
  get diagnostics v_metafields = row_count;

  return jsonb_build_object('products', cardinality(v_written),
    'stale', jsonb_array_length(coalesce(p_products, '[]')) - cardinality(v_written),
    'variants', v_variants, 'variants_removed', cardinality(v_removed_variants),
    'metafields', v_metafields, 'metafields_removed', v_metafields_removed);
end;
$$;

-- The shop's metafield and metaobject definitions, replaced as a whole: Shopify lists them in full.
create or replace function public.replace_catalog_definitions(p_shop_key integer, p_metafield_definitions jsonb, p_metaobject_definitions jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fields integer;
  v_objects integer;
  v_fields_removed integer;
  v_objects_removed integer;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_metafield_definitions, p_metaobject_definitions) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  delete from public.metafield_definitions d
   where d.shop_key = p_shop_key
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_metafield_definitions, '[]')) as x(owner_type text, namespace text, key text)
                      where x.owner_type = d.owner_type and x.namespace = d.namespace and x.key = d.key);
  get diagnostics v_fields_removed = row_count;
  insert into public.metafield_definitions as d (shop_key, owner_type, namespace, key, shopify_id, name, type, description, synced_at)
  select p_shop_key, x.owner_type, x.namespace, x.key, x.shopify_id, x.name, x.type, x.description, now()
    from jsonb_to_recordset(coalesce(p_metafield_definitions, '[]')) as x(owner_type text, namespace text, key text, shopify_id bigint,
         name text, type text, description text)
  on conflict (shop_key, owner_type, namespace, key) do update set
    shopify_id = excluded.shopify_id, name = excluded.name, type = excluded.type, description = excluded.description, synced_at = now();
  get diagnostics v_fields = row_count;

  delete from public.metaobject_definitions d
   where d.shop_key = p_shop_key
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_metaobject_definitions, '[]')) as x(shopify_id bigint) where x.shopify_id = d.shopify_id);
  get diagnostics v_objects_removed = row_count;
  insert into public.metaobject_definitions as d (shop_key, shopify_id, type, name, display_name_key, field_definitions, synced_at)
  select p_shop_key, x.shopify_id, x.type, x.name, x.display_name_key, coalesce(x.field_definitions, '[]'), now()
    from jsonb_to_recordset(coalesce(p_metaobject_definitions, '[]')) as x(shopify_id bigint, type text, name text, display_name_key text,
         field_definitions jsonb)
  on conflict (shop_key, shopify_id) do update set
    type = excluded.type, name = excluded.name, display_name_key = excluded.display_name_key,
    field_definitions = excluded.field_definitions, synced_at = now();
  get diagnostics v_objects = row_count;

  return jsonb_build_object('metafield_definitions', v_fields, 'metafield_definitions_removed', v_fields_removed,
    'metaobject_definitions', v_objects, 'metaobject_definitions_removed', v_objects_removed);
end;
$$;

-- Referenced metaobjects as Shopify returned them (newer wins), and those Shopify no longer has.
create or replace function public.ingest_metaobjects(p_shop_key integer, p_metaobjects jsonb, p_deleted bigint[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_written integer;
  v_deleted integer;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_metaobjects) + coalesce(cardinality(p_deleted), 0) > 2000 then raise exception 'ingest_batch_too_large'; end if;
  insert into public.metaobjects as o (shop_key, shopify_id, type, handle, display_name, fields, fields_truncated, shopify_updated_at, synced_at)
  select p_shop_key, x.shopify_id, x.type, x.handle, x.display_name, coalesce(x.fields, '{}'), coalesce(x.fields_truncated, false),
         x.shopify_updated_at, now()
    from jsonb_to_recordset(coalesce(p_metaobjects, '[]')) as x(shopify_id bigint, type text, handle text, display_name text, fields jsonb,
         fields_truncated boolean, shopify_updated_at timestamptz)
  on conflict (shop_key, shopify_id) do update set
    type = excluded.type, handle = excluded.handle, display_name = excluded.display_name, fields = excluded.fields,
    fields_truncated = excluded.fields_truncated, shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
   where o.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= o.shopify_updated_at;
  get diagnostics v_written = row_count;
  delete from public.metaobjects where shop_key = p_shop_key and shopify_id = any (coalesce(p_deleted, '{}'));
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('metaobjects', v_written, 'metaobjects_deleted', v_deleted);
end;
$$;

-- Metaobjects the catalog references (by product or variant metafields) that are not stored yet, or were
-- last read before p_stale_before; at most p_limit (1,000), lowest ID first.
create or replace function public.catalog_reference_ids(p_shop_key integer, p_stale_before timestamptz, p_limit integer default 250)
returns bigint[] language sql stable security definer set search_path = public, pg_temp as $$
  with refs as (
    select distinct (regexp_matches(m.value_excerpt, 'gid://shopify/Metaobject/([0-9]{1,18})', 'g'))[1]::bigint as id
      from public.metafields m
     where m.shop_key = p_shop_key and m.type ~ 'metaobject_reference|mixed_reference' and m.value_excerpt is not null
  )
  select coalesce(array_agg(id order by id), '{}')
    from (select r.id from refs r
            left join public.metaobjects o on o.shop_key = p_shop_key and o.shopify_id = r.id
           where o.shopify_id is null or (p_stale_before is not null and o.synced_at < p_stale_before)
           order by r.id
           limit least(greatest(coalesce(p_limit, 250), 1), 1000)) due;
$$;

-- The read path's products (0043), with the catalog fields above and variant metafields.
create or replace function public.insight_products(p_shop_key integer, p_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.shopify_id, 'title', p.title, 'handle', p.handle, 'description', p.description_excerpt, 'tags', p.tags,
           'product_type', p.product_type, 'vendor', p.vendor, 'status', p.status, 'created_at', p.shopify_created_at,
           'category', p.category, 'image_url', p.featured_image_url, 'fields_version', p.fields_version,
           'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.shopify_id, 'title', v.title, 'price', v.price,
                                   'inventory_quantity', v.inventory_quantity, 'unit_cost', v.unit_cost, 'unit_cost_currency', v.unit_cost_currency)
                                   order by v.position nulls last, v.shopify_id)
                                   from public.product_variants v where v.shop_key = p_shop_key and v.product_shopify_id = p.shopify_id), '[]'::jsonb),
           'metafields', coalesce((select jsonb_agg(jsonb_build_object('owner', m.owner_type, 'namespace', m.namespace, 'key', m.key,
                                     'type', m.type, 'value', m.value_excerpt, 'name', d.name)
                                     order by m.owner_type, m.namespace, m.key, m.owner_shopify_id)
                                     from public.metafields m
                                     left join public.metafield_definitions d on d.shop_key = m.shop_key and d.owner_type = m.owner_type
                                          and d.namespace = m.namespace and d.key = m.key
                                    where m.shop_key = p_shop_key and not m.value_truncated
                                      and ((m.owner_type = 'product' and m.owner_shopify_id = p.shopify_id)
                                           or (m.owner_type = 'variant' and m.owner_shopify_id in (
                                                 select v.shopify_id from public.product_variants v
                                                  where v.shop_key = p_shop_key and v.product_shopify_id = p.shopify_id)))), '[]'::jsonb)
         ) order by p.shopify_id), '[]'::jsonb)
    from public.products p
   where p.shop_key = p_shop_key and p.shopify_id = any ((coalesce(p_ids, '{}'))[1:500]);
$$;

-- Stored metaobjects by ID (at most 500), for resolving references on the read path.
create or replace function public.insight_metaobjects(p_shop_key integer, p_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', o.shopify_id, 'type', o.type, 'display_name', o.display_name, 'fields', o.fields,
           'definition_name', d.name) order by o.shopify_id), '[]'::jsonb)
    from public.metaobjects o
    left join public.metaobject_definitions d on d.shop_key = o.shop_key and d.type = o.type
   where o.shop_key = p_shop_key and o.shopify_id = any ((coalesce(p_ids, '{}'))[1:500]);
$$;

-- 0043's deletion helpers, with the metafield definitions.
create or replace function public.delete_shop_synced_data(p_domain text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_domain text := public.normalize_shop_host(p_domain);
  v_key integer;
begin
  if v_domain is null then return; end if;
  select shop_key into v_key from public.shops where myshopify_domain = v_domain;
  delete from public.webhook_events where shop_domain = v_domain or (v_key is not null and shop_key = v_key);
  if v_key is null then return; end if;
  delete from public.product_monthly_metrics where shop_key = v_key;
  delete from public.store_monthly_metrics where shop_key = v_key;
  delete from public.cohort_monthly_outcomes where shop_key = v_key;
  delete from public.product_monthly_adjustments where shop_key = v_key;
  delete from public.store_monthly_adjustments where shop_key = v_key;
  delete from public.history_arrivals where shop_key = v_key;
  delete from public.shop_insights where shop_key = v_key;
  delete from public.product_metrics where shop_key = v_key;
  delete from public.store_metrics where shop_key = v_key;
  delete from public.sync_checkpoints where shop_key = v_key;
  delete from public.sync_runs where shop_key = v_key;
  delete from public.return_line_items where shop_key = v_key;
  delete from public.returns where shop_key = v_key;
  delete from public.refunds where shop_key = v_key;
  delete from public.order_line_items where shop_key = v_key;
  delete from public.orders where shop_key = v_key;
  delete from public.customers where shop_key = v_key;
  delete from public.inventory_levels where shop_key = v_key;
  delete from public.inventory_locations where shop_key = v_key;
  delete from public.product_variants where shop_key = v_key;
  delete from public.products where shop_key = v_key;
  delete from public.metafields where shop_key = v_key;
  delete from public.metafield_definitions where shop_key = v_key;
  delete from public.metaobjects where shop_key = v_key;
  delete from public.metaobject_definitions where shop_key = v_key;
  delete from public.shop_settings where shop_key = v_key;
  delete from public.shop_access where shop_key = v_key;
  -- Last: deleting orders and return lines above marks their months again.
  delete from public.summary_dirty_months where shop_key = v_key;
end;
$$;

create or replace function public.shop_synced_row_count(p_domain text)
returns bigint language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_domain text := public.normalize_shop_host(p_domain);
  v_key integer;
  v_inbox bigint;
begin
  if v_domain is null then return 0; end if;
  select shop_key into v_key from public.shops where myshopify_domain = v_domain;
  select count(*) into v_inbox from public.webhook_events where shop_domain = v_domain or (v_key is not null and shop_key = v_key);
  if v_key is null then return v_inbox; end if;
  return v_inbox
       + (select count(*) from public.product_monthly_metrics where shop_key = v_key)
       + (select count(*) from public.store_monthly_metrics where shop_key = v_key)
       + (select count(*) from public.cohort_monthly_outcomes where shop_key = v_key)
       + (select count(*) from public.product_monthly_adjustments where shop_key = v_key)
       + (select count(*) from public.store_monthly_adjustments where shop_key = v_key)
       + (select count(*) from public.history_arrivals where shop_key = v_key)
       + (select count(*) from public.shop_insights where shop_key = v_key)
       + (select count(*) from public.summary_dirty_months where shop_key = v_key)
       + (select count(*) from public.product_metrics where shop_key = v_key)
       + (select count(*) from public.store_metrics where shop_key = v_key)
       + (select count(*) from public.sync_checkpoints where shop_key = v_key)
       + (select count(*) from public.sync_runs where shop_key = v_key)
       + (select count(*) from public.products where shop_key = v_key)
       + (select count(*) from public.product_variants where shop_key = v_key)
       + (select count(*) from public.inventory_locations where shop_key = v_key)
       + (select count(*) from public.inventory_levels where shop_key = v_key)
       + (select count(*) from public.customers where shop_key = v_key)
       + (select count(*) from public.orders where shop_key = v_key)
       + (select count(*) from public.order_line_items where shop_key = v_key)
       + (select count(*) from public.refunds where shop_key = v_key)
       + (select count(*) from public.returns where shop_key = v_key)
       + (select count(*) from public.return_line_items where shop_key = v_key)
       + (select count(*) from public.metafields where shop_key = v_key)
       + (select count(*) from public.metafield_definitions where shop_key = v_key)
       + (select count(*) from public.metaobject_definitions where shop_key = v_key)
       + (select count(*) from public.metaobjects where shop_key = v_key)
       + (select count(*) from public.shop_settings where shop_key = v_key)
       + (select count(*) from public.shop_access where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

revoke all on function public.replace_catalog_definitions(integer, jsonb, jsonb), public.ingest_metaobjects(integer, jsonb, bigint[]),
  public.catalog_reference_ids(integer, timestamptz, integer), public.insight_metaobjects(integer, bigint[])
  from public, anon, authenticated;
grant execute on function public.replace_catalog_definitions(integer, jsonb, jsonb), public.ingest_metaobjects(integer, jsonb, bigint[]),
  public.catalog_reference_ids(integer, timestamptz, integer), public.insight_metaobjects(integer, bigint[])
  to service_role;
