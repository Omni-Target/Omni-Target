-- Phase 2, task 11: the read path.
--
-- The dashboard, products page and briefs read a store snapshot (the legacy StoreData shape). It
-- used to be built inside HTTP requests from a bounded Shopify REST sync. Now a worker builds it
-- from the canonical mirror and stores it here, one row per shop; requests only read it.
--  - insight_orders_page, insight_catalog and insight_products read the mirror in bounded pages
--    for the worker (each call well inside the 8 s statement timeout);
--  - save_shop_insights stores a result for a shop that is still ingestible;
--  - shops_insights_due lists the shops whose result is missing or older than a given age.
-- The snapshot is derived data: aggregates per store and product, with no customer identifiers.
-- It is deleted with the shop's mirrored data. Changes no existing rows.

create table public.shop_insights (
  shop_key        integer primary key references public.shops (shop_key),
  schema_version  integer not null check (schema_version > 0),
  data            jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 8388608),
  inputs          jsonb not null default '{}' check (jsonb_typeof(inputs) = 'object' and pg_column_size(inputs) <= 8192),
  computed_at     timestamptz not null default now()
);

-- One page of the orders the snapshot analyses, newest first: inside the window, paid or partially
-- refunded, not test or cancelled; with their lines and their customer's order count.
create or replace function public.insight_orders_page(p_shop_key integer, p_before timestamptz, p_before_id bigint, p_limit integer default 2000)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with page as (
    select o.shopify_id, o.processed_at, o.total_price, o.subtotal, o.financial_status, o.source_name, o.customer_shopify_id,
           o.ship_city, o.ship_province_code, o.ship_country_code
      from public.orders o
     where o.shop_key = p_shop_key and not o.is_test and o.cancelled_at is null
       and o.financial_status in ('paid', 'partially_refunded')
       and o.processed_at >= public.shop_window_start(p_shop_key)
       and (p_before is null or (o.processed_at, o.shopify_id) < (p_before, coalesce(p_before_id, 0)))
     order by o.processed_at desc, o.shopify_id desc
     limit least(greatest(coalesce(p_limit, 2000), 1), 2000)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.shopify_id, 'processed_at', p.processed_at, 'total_price', p.total_price, 'subtotal', p.subtotal,
           'financial_status', p.financial_status, 'source_name', p.source_name,
           'customer_id', p.customer_shopify_id, 'customer_orders', c.orders_count, 'customer_created_at', c.shopify_created_at,
           'city', p.ship_city, 'province_code', p.ship_province_code, 'country_code', p.ship_country_code,
           'lines', coalesce((select jsonb_agg(jsonb_build_object('product_id', li.product_shopify_id, 'variant_id', li.variant_shopify_id,
                                'quantity', li.quantity, 'price', li.unit_price) order by li.shopify_id)
                                from public.order_line_items li where li.shop_key = p_shop_key and li.order_shopify_id = p.shopify_id), '[]'::jsonb)
         ) order by p.processed_at desc, p.shopify_id desc), '[]'::jsonb)
    from page p
    left join public.customers c on c.shop_key = p_shop_key and c.shopify_id = p.customer_shopify_id;
$$;

-- The active catalog's size and its most recently updated products.
create or replace function public.insight_catalog(p_shop_key integer, p_limit integer default 2000)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'active', (select count(*) from public.products where shop_key = p_shop_key and status = 'active'),
    'ids', coalesce((select jsonb_agg(x.shopify_id) from (
              select shopify_id from public.products where shop_key = p_shop_key and status = 'active'
               order by shopify_updated_at desc nulls last, shopify_id desc
               limit least(greatest(coalesce(p_limit, 2000), 1), 5000)) x), '[]'::jsonb));
$$;

-- Products with their variants and complete metafields, at most 500 per call.
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

-- Stores a shop's snapshot, while the shop is still ingestible.
create or replace function public.save_shop_insights(p_shop_key integer, p_schema_version integer, p_data jsonb, p_inputs jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  insert into public.shop_insights as i (shop_key, schema_version, data, inputs, computed_at)
  values (p_shop_key, p_schema_version, p_data, coalesce(p_inputs, '{}'), now())
  on conflict (shop_key) do update
    set schema_version = excluded.schema_version, data = excluded.data, inputs = excluded.inputs, computed_at = excluded.computed_at;
  return jsonb_build_object('saved', true, 'bytes', pg_column_size(p_data));
end;
$$;

-- Shops ready for maintenance whose snapshot is missing or older than the given age, oldest first.
create or replace function public.shops_insights_due(p_max_age_seconds integer default 21600, p_limit integer default 100)
returns table (shop_domain text, computed_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.myshopify_domain, i.computed_at
    from public.shops s
    left join public.shop_insights i on i.shop_key = s.shop_key
   where public.summary_maintenance_ready(s.shop_key)
     and (i.shop_key is null or i.computed_at < now() - make_interval(secs => greatest(coalesce(p_max_age_seconds, 21600), 60)))
   order by i.computed_at nulls first, s.shop_key
   limit least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

-- 0042's deletion helpers, with the snapshot.
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

alter table public.shop_insights enable row level security;
revoke all on table public.shop_insights from public, anon, authenticated, service_role;
grant select on table public.shop_insights to service_role;

revoke all on function public.insight_orders_page(integer, timestamptz, bigint, integer), public.insight_catalog(integer, integer),
  public.insight_products(integer, bigint[]), public.save_shop_insights(integer, integer, jsonb, jsonb), public.shops_insights_due(integer, integer)
  from public, anon, authenticated;
grant execute on function public.insight_orders_page(integer, timestamptz, bigint, integer), public.insight_catalog(integer, integer),
  public.insight_products(integer, bigint[]), public.save_shop_insights(integer, integer, jsonb, jsonb), public.shops_insights_due(integer, integer)
  to service_role;
