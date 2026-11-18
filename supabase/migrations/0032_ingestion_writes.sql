-- 0032: ingestion writes (Phase 2, task 4).
--
-- Every write of Shopify data into the commerce mirror goes through these
-- functions, in batches bounded well inside PostgREST's 8 s statement timeout:
--
--  - lock_shop_for_ingestion first (0031): only a shop bound to an active
--    workspace is written, and the workspace is held until the batch commits;
--  - newer wins: a row is replaced only by data at least as recent
--    (shopify_updated_at), so replays and out-of-order deliveries are safe;
--  - a record arrives with all its children (a bulk unit), so a written
--    record's children missing from the batch were deleted in Shopify and are
--    removed;
--  - redaction suppression (0031): a suppressed customer or order is stored
--    without its customer reference and destination, and a suppressed
--    customer row is not stored at all;
--  - orders older than the 24-month window are not stored (decision 3: task 7
--    summarises them instead).
--
-- Changes no existing rows.

create or replace function public.ingest_batch_size(variadic p_parts jsonb[])
returns integer language sql immutable set search_path = public, pg_temp as $$
  select coalesce(sum(case when jsonb_typeof(p) = 'array' then jsonb_array_length(p) else 0 end), 0)::integer from unnest(p_parts) p;
$$;

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

create or replace function public.ingest_inventory(p_shop_key integer, p_locations jsonb, p_levels jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_locations integer := 0;
  v_levels integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_locations, p_levels) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  insert into public.inventory_locations as l (shop_key, shopify_id, name, country_code, province_code, is_active, fulfills_online_orders, is_fulfillment_service, synced_at)
  select p_shop_key, x.shopify_id, x.name, x.country_code, x.province_code, coalesce(x.is_active, true), x.fulfills_online_orders,
         coalesce(x.is_fulfillment_service, false), now()
    from jsonb_to_recordset(coalesce(p_locations, '[]')) as x(shopify_id bigint, name text, country_code text, province_code text,
         is_active boolean, fulfills_online_orders boolean, is_fulfillment_service boolean)
  on conflict (shop_key, shopify_id) do update set
    name = excluded.name, country_code = excluded.country_code, province_code = excluded.province_code, is_active = excluded.is_active,
    fulfills_online_orders = excluded.fulfills_online_orders, is_fulfillment_service = excluded.is_fulfillment_service, synced_at = now();
  get diagnostics v_locations = row_count;

  insert into public.inventory_levels as l (shop_key, inventory_item_id, location_shopify_id, available, on_hand, shopify_updated_at, synced_at)
  select p_shop_key, x.inventory_item_id, x.location_shopify_id, x.available, x.on_hand, x.shopify_updated_at, now()
    from jsonb_to_recordset(coalesce(p_levels, '[]')) as x(inventory_item_id bigint, location_shopify_id bigint, available integer,
         on_hand integer, shopify_updated_at timestamptz)
  on conflict (shop_key, inventory_item_id, location_shopify_id) do update set
    available = excluded.available, on_hand = excluded.on_hand, shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
   where l.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= l.shopify_updated_at;
  get diagnostics v_levels = row_count;

  return jsonb_build_object('locations', v_locations, 'levels', v_levels);
end;
$$;

create or replace function public.ingest_orders(p_shop_key integer, p_orders jsonb, p_line_items jsonb, p_refunds jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shopify_shop bigint;
  v_cutoff timestamptz := now() - interval '24 months';
  v_written bigint[];
  v_beyond integer := 0;
  v_suppressed integer := 0;
  v_lines integer := 0;
  v_lines_removed integer := 0;
  v_refunds integer := 0;
  v_refunds_removed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_orders, p_line_items, p_refunds) > 2000 then raise exception 'ingest_batch_too_large'; end if;
  select shopify_shop_id into v_shopify_shop from public.shops where shop_key = p_shop_key;

  select count(*) filter (where x.processed_at < v_cutoff),
         count(*) filter (where x.processed_at >= v_cutoff and (
           exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'customer'
                    and x.customer_digest is not null and s.subject_digest = decode(x.customer_digest, 'hex'))
           or exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'order'
                    and x.order_digest is not null and s.subject_digest = decode(x.order_digest, 'hex'))))
    into v_beyond, v_suppressed
    from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(processed_at timestamptz, customer_digest text, order_digest text);

  with incoming as (
    select x.*,
           exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'customer'
                    and x.customer_digest is not null and s.subject_digest = decode(x.customer_digest, 'hex'))
        or exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'order'
                    and x.order_digest is not null and s.subject_digest = decode(x.order_digest, 'hex')) as suppressed
      from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(
        shopify_id bigint, name text, shopify_created_at timestamptz, processed_at timestamptz, cancelled_at timestamptz,
        financial_status text, fulfillment_status text, currency text, presentment_currency text, subtotal numeric, total_discounts numeric,
        total_tax numeric, total_shipping numeric, total_price numeric, total_refunded numeric, customer_shopify_id bigint,
        ship_country_code text, ship_province_code text, ship_city text, ship_city_raw text, source_name text, is_test boolean,
        shopify_updated_at timestamptz, customer_digest text, order_digest text)
     where x.processed_at >= v_cutoff
  ), written as (
    insert into public.orders as o (shop_key, shopify_id, name, shopify_created_at, processed_at, cancelled_at, financial_status,
      fulfillment_status, currency, presentment_currency, subtotal, total_discounts, total_tax, total_shipping, total_price, total_refunded,
      customer_shopify_id, ship_country_code, ship_province_code, ship_city, ship_city_raw, source_name, is_test, shopify_updated_at, synced_at)
    select p_shop_key, shopify_id, name, shopify_created_at, processed_at, cancelled_at, financial_status, fulfillment_status, currency,
           presentment_currency, coalesce(subtotal, 0), coalesce(total_discounts, 0), coalesce(total_tax, 0), coalesce(total_shipping, 0),
           total_price, coalesce(total_refunded, 0),
           case when suppressed then null else customer_shopify_id end, ship_country_code,
           case when suppressed then null else ship_province_code end,
           case when suppressed then null else ship_city end,
           case when suppressed then null else ship_city_raw end,
           source_name, coalesce(is_test, false), shopify_updated_at, now()
      from incoming
    on conflict (shop_key, shopify_id) do update set
      name = excluded.name, shopify_created_at = excluded.shopify_created_at, processed_at = excluded.processed_at,
      cancelled_at = excluded.cancelled_at, financial_status = excluded.financial_status, fulfillment_status = excluded.fulfillment_status,
      currency = excluded.currency, presentment_currency = excluded.presentment_currency, subtotal = excluded.subtotal,
      total_discounts = excluded.total_discounts, total_tax = excluded.total_tax, total_shipping = excluded.total_shipping,
      total_price = excluded.total_price, total_refunded = excluded.total_refunded, customer_shopify_id = excluded.customer_shopify_id,
      ship_country_code = excluded.ship_country_code, ship_province_code = excluded.ship_province_code, ship_city = excluded.ship_city,
      ship_city_raw = excluded.ship_city_raw, source_name = excluded.source_name, is_test = excluded.is_test,
      shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
     where o.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= o.shopify_updated_at
    returning o.shopify_id
  )
  select coalesce(array_agg(shopify_id), '{}') into v_written from written;

  insert into public.order_line_items as li (shop_key, shopify_id, order_shopify_id, product_shopify_id, variant_shopify_id, title, sku,
    quantity, current_quantity, refunded_quantity, unit_price, total_discount)
  select p_shop_key, x.shopify_id, x.order_shopify_id, x.product_shopify_id, x.variant_shopify_id, x.title, x.sku, x.quantity,
         x.current_quantity, coalesce(x.refunded_quantity, 0), x.unit_price, coalesce(x.total_discount, 0)
    from jsonb_to_recordset(coalesce(p_line_items, '[]')) as x(shopify_id bigint, order_shopify_id bigint, product_shopify_id bigint,
         variant_shopify_id bigint, title text, sku text, quantity integer, current_quantity integer, refunded_quantity integer,
         unit_price numeric, total_discount numeric)
   where x.order_shopify_id = any (v_written)
  on conflict (shop_key, shopify_id) do update set
    order_shopify_id = excluded.order_shopify_id, product_shopify_id = excluded.product_shopify_id,
    variant_shopify_id = excluded.variant_shopify_id, title = excluded.title, sku = excluded.sku, quantity = excluded.quantity,
    current_quantity = excluded.current_quantity, refunded_quantity = excluded.refunded_quantity, unit_price = excluded.unit_price,
    total_discount = excluded.total_discount;
  get diagnostics v_lines = row_count;

  delete from public.order_line_items li
   where li.shop_key = p_shop_key and li.order_shopify_id = any (v_written)
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_line_items, '[]')) as x(shopify_id bigint) where x.shopify_id = li.shopify_id);
  get diagnostics v_lines_removed = row_count;

  insert into public.refunds as r (shop_key, shopify_id, order_shopify_id, shopify_created_at, total_refunded, currency)
  select p_shop_key, x.shopify_id, x.order_shopify_id, x.shopify_created_at, x.total_refunded, x.currency
    from jsonb_to_recordset(coalesce(p_refunds, '[]')) as x(shopify_id bigint, order_shopify_id bigint, shopify_created_at timestamptz,
         total_refunded numeric, currency text)
   where x.order_shopify_id = any (v_written)
  on conflict (shop_key, shopify_id) do update set
    order_shopify_id = excluded.order_shopify_id, shopify_created_at = excluded.shopify_created_at,
    total_refunded = excluded.total_refunded, currency = excluded.currency;
  get diagnostics v_refunds = row_count;

  delete from public.refunds r
   where r.shop_key = p_shop_key and r.order_shopify_id = any (v_written)
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_refunds, '[]')) as x(shopify_id bigint) where x.shopify_id = r.shopify_id);
  get diagnostics v_refunds_removed = row_count;

  return jsonb_build_object('orders', cardinality(v_written),
    'stale', jsonb_array_length(coalesce(p_orders, '[]')) - v_beyond - cardinality(v_written),
    'beyond_window', v_beyond, 'suppressed', v_suppressed,
    'line_items', v_lines, 'line_items_removed', v_lines_removed, 'refunds', v_refunds, 'refunds_removed', v_refunds_removed);
end;
$$;

create or replace function public.ingest_customers(p_shop_key integer, p_customers jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shopify_shop bigint;
  v_written integer := 0;
  v_suppressed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_customers) > 2000 then raise exception 'ingest_batch_too_large'; end if;
  select shopify_shop_id into v_shopify_shop from public.shops where shop_key = p_shop_key;

  select count(*) into v_suppressed
    from jsonb_to_recordset(coalesce(p_customers, '[]')) as x(digest text)
   where exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'customer'
                  and x.digest is not null and s.subject_digest = decode(x.digest, 'hex'));

  insert into public.customers as c (shop_key, shopify_id, orders_count, amount_spent, amount_spent_currency, shopify_created_at, shopify_updated_at, synced_at)
  select p_shop_key, x.shopify_id, x.orders_count, x.amount_spent, x.amount_spent_currency, x.shopify_created_at, x.shopify_updated_at, now()
    from jsonb_to_recordset(coalesce(p_customers, '[]')) as x(shopify_id bigint, orders_count integer, amount_spent numeric,
         amount_spent_currency text, shopify_created_at timestamptz, shopify_updated_at timestamptz, digest text)
   where not exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'customer'
                      and x.digest is not null and s.subject_digest = decode(x.digest, 'hex'))
  on conflict (shop_key, shopify_id) do update set
    orders_count = excluded.orders_count, amount_spent = excluded.amount_spent, amount_spent_currency = excluded.amount_spent_currency,
    shopify_created_at = excluded.shopify_created_at, shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
   where c.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= c.shopify_updated_at;
  get diagnostics v_written = row_count;

  return jsonb_build_object('customers', v_written, 'suppressed', v_suppressed);
end;
$$;

-- Each customer's first and last order within the retained window (task 7
-- extends the first order with history beyond it). Batched by customer ID.
create or replace function public.derive_customer_order_facts(p_shop_key integer, p_after bigint default 0, p_limit integer default 2000)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated integer := 0;
  v_last bigint;
  v_seen integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if p_limit is null or p_limit < 1 or p_limit > 5000 then raise exception 'ingest_batch_too_large'; end if;

  select count(*), max(shopify_id) into v_seen, v_last
    from (select shopify_id from public.customers where shop_key = p_shop_key and shopify_id > coalesce(p_after, 0) order by shopify_id limit p_limit) b;

  with batch as (
    select shopify_id from public.customers where shop_key = p_shop_key and shopify_id > coalesce(p_after, 0) order by shopify_id limit p_limit
  ), facts as (
    select b.shopify_id, f.shopify_id as first_id, f.processed_at as first_at, l.processed_at as last_at,
           coalesce((select array_agg(distinct li.product_shopify_id) filter (where li.product_shopify_id is not null)
                       from public.order_line_items li where li.shop_key = p_shop_key and li.order_shopify_id = f.shopify_id), '{}') as products
      from batch b
      left join lateral (select o.shopify_id, o.processed_at from public.orders o
                          where o.shop_key = p_shop_key and o.customer_shopify_id = b.shopify_id and not o.is_test and o.cancelled_at is null
                          order by o.processed_at, o.shopify_id limit 1) f on true
      left join lateral (select o.processed_at from public.orders o
                          where o.shop_key = p_shop_key and o.customer_shopify_id = b.shopify_id and not o.is_test and o.cancelled_at is null
                          order by o.processed_at desc limit 1) l on true
  )
  update public.customers c
     set first_order_shopify_id = f.first_id, first_order_at = f.first_at, last_order_at = f.last_at,
         first_order_product_shopify_ids = f.products[1:100]
    from facts f
   where c.shop_key = p_shop_key and c.shopify_id = f.shopify_id
     and (c.first_order_shopify_id is distinct from f.first_id or c.first_order_at is distinct from f.first_at
          or c.last_order_at is distinct from f.last_at or c.first_order_product_shopify_ids is distinct from f.products[1:100]);
  get diagnostics v_updated = row_count;

  return jsonb_build_object('updated', v_updated, 'next_after', case when v_seen < p_limit then null else v_last end);
end;
$$;

create or replace function public.ingest_returns(p_shop_key integer, p_returns jsonb, p_return_line_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_returns integer := 0;
  v_lines integer := 0;
  v_lines_removed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_returns, p_return_line_items) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  insert into public.returns as r (shop_key, shopify_id, order_shopify_id, name, status, total_quantity, shopify_created_at, closed_at, synced_at)
  select p_shop_key, x.shopify_id, x.order_shopify_id, x.name, x.status, x.total_quantity, x.shopify_created_at, x.closed_at, now()
    from jsonb_to_recordset(coalesce(p_returns, '[]')) as x(shopify_id bigint, order_shopify_id bigint, name text, status text,
         total_quantity integer, shopify_created_at timestamptz, closed_at timestamptz)
  on conflict (shop_key, shopify_id) do update set
    order_shopify_id = excluded.order_shopify_id, name = excluded.name, status = excluded.status, total_quantity = excluded.total_quantity,
    shopify_created_at = excluded.shopify_created_at, closed_at = excluded.closed_at, synced_at = now();
  get diagnostics v_returns = row_count;

  insert into public.return_line_items as rl (shop_key, shopify_id, return_shopify_id, line_item_shopify_id, quantity, return_reason)
  select p_shop_key, x.shopify_id, x.return_shopify_id, x.line_item_shopify_id, x.quantity, x.return_reason
    from jsonb_to_recordset(coalesce(p_return_line_items, '[]')) as x(shopify_id bigint, return_shopify_id bigint,
         line_item_shopify_id bigint, quantity integer, return_reason text)
   where exists (select 1 from jsonb_to_recordset(coalesce(p_returns, '[]')) as r(shopify_id bigint) where r.shopify_id = x.return_shopify_id)
  on conflict (shop_key, shopify_id) do update set
    return_shopify_id = excluded.return_shopify_id, line_item_shopify_id = excluded.line_item_shopify_id,
    quantity = excluded.quantity, return_reason = excluded.return_reason;
  get diagnostics v_lines = row_count;

  delete from public.return_line_items rl
   where rl.shop_key = p_shop_key
     and rl.return_shopify_id in (select r.shopify_id from jsonb_to_recordset(coalesce(p_returns, '[]')) as r(shopify_id bigint))
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_return_line_items, '[]')) as x(shopify_id bigint) where x.shopify_id = rl.shopify_id);
  get diagnostics v_lines_removed = row_count;

  return jsonb_build_object('returns', v_returns, 'return_line_items', v_lines, 'return_line_items_removed', v_lines_removed);
end;
$$;

-- Where an import resumes. Never moves the committed line back within one bulk operation.
create or replace function public.save_sync_checkpoint(p_shop_key integer, p_domain text, p_sync_run uuid, p_bulk_operation_id bigint,
  p_committed_line bigint, p_watermark timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_line bigint;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  insert into public.sync_checkpoints as c (shop_key, domain, sync_run_id, bulk_operation_id, committed_line, watermark, updated_at)
  values (p_shop_key, p_domain, p_sync_run, p_bulk_operation_id, coalesce(p_committed_line, 0), p_watermark, now())
  on conflict (shop_key, domain) do update set
    sync_run_id = excluded.sync_run_id, bulk_operation_id = excluded.bulk_operation_id, committed_line = excluded.committed_line,
    watermark = coalesce(excluded.watermark, c.watermark), updated_at = now()
   where c.bulk_operation_id is distinct from excluded.bulk_operation_id or excluded.committed_line >= c.committed_line
  returning committed_line into v_line;
  return jsonb_build_object('outcome', case when v_line is null then 'stale' else 'saved' end);
end;
$$;

revoke all on function public.ingest_batch_size(jsonb[]),
  public.ingest_catalog(integer, jsonb, jsonb, jsonb), public.ingest_inventory(integer, jsonb, jsonb),
  public.ingest_orders(integer, jsonb, jsonb, jsonb), public.ingest_customers(integer, jsonb),
  public.derive_customer_order_facts(integer, bigint, integer), public.ingest_returns(integer, jsonb, jsonb),
  public.save_sync_checkpoint(integer, text, uuid, bigint, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.ingest_catalog(integer, jsonb, jsonb, jsonb), public.ingest_inventory(integer, jsonb, jsonb),
  public.ingest_orders(integer, jsonb, jsonb, jsonb), public.ingest_customers(integer, jsonb),
  public.derive_customer_order_facts(integer, bigint, integer), public.ingest_returns(integer, jsonb, jsonb),
  public.save_sync_checkpoint(integer, text, uuid, bigint, bigint, timestamptz)
  to service_role;
