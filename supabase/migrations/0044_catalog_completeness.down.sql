-- Reverts 0044: the earlier catalog write (0032), read-path products (0043) and deletion helpers (0043),
-- then the new functions, table, index and columns. Data in the dropped columns and table is lost; it is
-- re-read from Shopify by the next catalog import after re-applying 0044.

create or replace function public.ingest_catalog(p_shop_key integer, p_products jsonb, p_variants jsonb, p_metafields jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_written bigint[];
  v_variants integer := 0;
  v_variants_removed integer := 0;
  v_metafields integer := 0;
  v_metafields_removed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_products, p_variants, p_metafields) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  with incoming as (
    select * from jsonb_to_recordset(coalesce(p_products, '[]')) as x(
      shopify_id bigint, title text, handle text, status text, product_type text, vendor text, category text, tags text[],
      description_excerpt text, is_gift_card boolean, published_at timestamptz, shopify_created_at timestamptz, shopify_updated_at timestamptz)
  ), written as (
    insert into public.products as p (shop_key, shopify_id, title, handle, status, product_type, vendor, category, tags,
      description_excerpt, is_gift_card, published_at, shopify_created_at, shopify_updated_at, synced_at)
    select p_shop_key, shopify_id, title, handle, status, product_type, vendor, category, coalesce(tags, '{}'),
           description_excerpt, coalesce(is_gift_card, false), published_at, shopify_created_at, shopify_updated_at, now()
      from incoming
    on conflict (shop_key, shopify_id) do update set
      title = excluded.title, handle = excluded.handle, status = excluded.status, product_type = excluded.product_type,
      vendor = excluded.vendor, category = excluded.category, tags = excluded.tags, description_excerpt = excluded.description_excerpt,
      is_gift_card = excluded.is_gift_card, published_at = excluded.published_at, shopify_created_at = excluded.shopify_created_at,
      shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
     where p.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= p.shopify_updated_at
    returning p.shopify_id
  )
  select coalesce(array_agg(shopify_id), '{}') into v_written from written;

  insert into public.product_variants as v (shop_key, shopify_id, product_shopify_id, title, sku, position, selected_options, price,
    compare_at_price, taxable, inventory_item_id, tracked, inventory_policy, inventory_quantity, requires_shipping, weight, weight_unit,
    unit_cost, unit_cost_currency, country_of_origin, shopify_created_at, shopify_updated_at, synced_at)
  select p_shop_key, x.shopify_id, x.product_shopify_id, x.title, x.sku, x.position, coalesce(x.selected_options, '[]'), x.price,
         x.compare_at_price, x.taxable, x.inventory_item_id, x.tracked, x.inventory_policy, x.inventory_quantity, x.requires_shipping,
         x.weight, x.weight_unit, x.unit_cost, x.unit_cost_currency, x.country_of_origin, x.shopify_created_at, x.shopify_updated_at, now()
    from jsonb_to_recordset(coalesce(p_variants, '[]')) as x(
      shopify_id bigint, product_shopify_id bigint, title text, sku text, position integer, selected_options jsonb, price numeric,
      compare_at_price numeric, taxable boolean, inventory_item_id bigint, tracked boolean, inventory_policy text, inventory_quantity integer,
      requires_shipping boolean, weight numeric, weight_unit text, unit_cost numeric, unit_cost_currency text, country_of_origin text,
      shopify_created_at timestamptz, shopify_updated_at timestamptz)
   where x.product_shopify_id = any (v_written)
  on conflict (shop_key, shopify_id) do update set
    product_shopify_id = excluded.product_shopify_id, title = excluded.title, sku = excluded.sku, position = excluded.position,
    selected_options = excluded.selected_options, price = excluded.price, compare_at_price = excluded.compare_at_price,
    taxable = excluded.taxable, inventory_item_id = excluded.inventory_item_id, tracked = excluded.tracked,
    inventory_policy = excluded.inventory_policy, inventory_quantity = excluded.inventory_quantity,
    requires_shipping = excluded.requires_shipping, weight = excluded.weight, weight_unit = excluded.weight_unit,
    unit_cost = excluded.unit_cost, unit_cost_currency = excluded.unit_cost_currency, country_of_origin = excluded.country_of_origin,
    shopify_created_at = excluded.shopify_created_at, shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
   where v.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= v.shopify_updated_at;
  get diagnostics v_variants = row_count;

  delete from public.product_variants v
   where v.shop_key = p_shop_key and v.product_shopify_id = any (v_written)
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_variants, '[]')) as x(shopify_id bigint) where x.shopify_id = v.shopify_id);
  get diagnostics v_variants_removed = row_count;

  delete from public.metafields m
   where m.shop_key = p_shop_key and m.owner_type = 'product' and m.owner_shopify_id = any (v_written)
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_metafields, '[]')) as x(owner_shopify_id bigint, namespace text, key text)
                      where x.owner_shopify_id = m.owner_shopify_id and x.namespace = m.namespace and x.key = m.key);
  get diagnostics v_metafields_removed = row_count;

  insert into public.metafields as m (shop_key, owner_type, owner_shopify_id, namespace, key, type, value_excerpt, value_truncated, shopify_updated_at, synced_at)
  select p_shop_key, 'product', x.owner_shopify_id, x.namespace, x.key, x.type, x.value_excerpt, coalesce(x.value_truncated, false), x.shopify_updated_at, now()
    from jsonb_to_recordset(coalesce(p_metafields, '[]')) as x(owner_shopify_id bigint, namespace text, key text, type text,
         value_excerpt text, value_truncated boolean, shopify_updated_at timestamptz)
   where x.owner_shopify_id = any (v_written)
  on conflict (shop_key, owner_type, owner_shopify_id, namespace, key) do update set
    type = excluded.type, value_excerpt = excluded.value_excerpt, value_truncated = excluded.value_truncated,
    shopify_updated_at = excluded.shopify_updated_at, synced_at = now();
  get diagnostics v_metafields = row_count;

  return jsonb_build_object('products', cardinality(v_written),
    'stale', jsonb_array_length(coalesce(p_products, '[]')) - cardinality(v_written),
    'variants', v_variants, 'variants_removed', v_variants_removed,
    'metafields', v_metafields, 'metafields_removed', v_metafields_removed);
end;
$$;

create or replace function public.insight_products(p_shop_key integer, p_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.shopify_id, 'title', p.title, 'handle', p.handle, 'description', p.description_excerpt, 'tags', p.tags,
           'product_type', p.product_type, 'vendor', p.vendor, 'status', p.status, 'created_at', p.shopify_created_at,
           'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.shopify_id, 'title', v.title, 'price', v.price,
                                   'inventory_quantity', v.inventory_quantity, 'unit_cost', v.unit_cost, 'unit_cost_currency', v.unit_cost_currency)
                                   order by v.position nulls last, v.shopify_id)
                                   from public.product_variants v where v.shop_key = p_shop_key and v.product_shopify_id = p.shopify_id), '[]'::jsonb),
           'metafields', coalesce((select jsonb_agg(jsonb_build_object('namespace', m.namespace, 'key', m.key, 'type', m.type, 'value', m.value_excerpt)
                                     order by m.namespace, m.key)
                                     from public.metafields m where m.shop_key = p_shop_key and m.owner_type = 'product'
                                      and m.owner_shopify_id = p.shopify_id and not m.value_truncated), '[]'::jsonb)
         ) order by p.shopify_id), '[]'::jsonb)
    from public.products p
   where p.shop_key = p_shop_key and p.shopify_id = any ((coalesce(p_ids, '{}'))[1:500]);
$$;

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
       + (select count(*) from public.metaobject_definitions where shop_key = v_key)
       + (select count(*) from public.metaobjects where shop_key = v_key)
       + (select count(*) from public.shop_settings where shop_key = v_key)
       + (select count(*) from public.shop_access where shop_key = v_key);
end;
$$;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;

drop function public.insight_metaobjects(integer, bigint[]);
drop function public.catalog_reference_ids(integer, timestamptz, integer);
drop function public.ingest_metaobjects(integer, jsonb, bigint[]);
drop function public.replace_catalog_definitions(integer, jsonb, jsonb);
drop index public.metafields_references_idx;
drop table public.metafield_definitions;
delete from public.metafields where owner_type = 'variant';

alter table public.metaobjects drop column fields_truncated;
alter table public.metaobject_definitions drop column display_name_key;
alter table public.product_variants
  drop column barcode, drop column available_for_sale, drop column requires_components, drop column unit_price_measurement,
  drop column harmonized_system_code, drop column province_of_origin;
alter table public.products
  drop column fields_version, drop column description_truncated, drop column category_id, drop column option_names,
  drop column has_only_default_variant, drop column requires_selling_plan, drop column is_bundle, drop column combined_listing_role,
  drop column featured_image_url, drop column featured_image_alt, drop column featured_image_width, drop column featured_image_height,
  drop column media_count, drop column online_store_url;
