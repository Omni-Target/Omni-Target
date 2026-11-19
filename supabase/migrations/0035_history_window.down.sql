-- Reverses 0035: the 0034 history functions, claim and ingest_orders, and 0032's derive_customer_order_facts, return
-- unchanged; the pinned window starts and the customers' history facts are dropped.
drop function public.stage_history_orders(uuid, text, jsonb, jsonb);
drop function public.summarise_history_month(uuid, text, date, integer);
drop function public.discard_history_stage(uuid, text, integer);

create or replace function public.claim_shop_import(p_import uuid, p_run_id text, p_stale_seconds integer default 900)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.shop_imports;
  v_shop public.shops;
begin
  select * into v_row from public.shop_imports where id = p_import for update;
  if not found then return jsonb_build_object('outcome', 'missing'); end if;
  if v_row.status in ('succeeded', 'partial', 'failed', 'cancelled') then
    return jsonb_build_object('outcome', 'finished', 'status', v_row.status);
  end if;
  if v_row.status = 'running' and v_row.trigger_run_id is distinct from p_run_id
     and v_row.heartbeat_at > now() - make_interval(secs => p_stale_seconds) then
    return jsonb_build_object('outcome', 'busy');
  end if;
  update public.shop_imports set status = 'running', trigger_run_id = p_run_id, started_at = coalesce(started_at, now()), heartbeat_at = now()
   where id = p_import;
  select * into v_shop from public.shops where id = v_row.shop_id;
  return jsonb_build_object('outcome', 'claimed', 'shop_key', v_shop.shop_key, 'shop_domain', v_shop.myshopify_domain,
    'shopify_shop_id', v_shop.shopify_shop_id, 'coverage', v_row.coverage, 'window_start', public.retention_window_start());
end;
$$;

create or replace function public.stage_history_orders(p_import uuid, p_orders jsonb, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop_key integer;
  v_shopify_shop bigint;
  v_start timestamptz := public.retention_window_start();
  v_orders integer := 0;
  v_lines integer := 0;
  v_in_window integer := 0;
  v_suppressed integer := 0;
begin
  select s.shop_key, s.shopify_shop_id into v_shop_key, v_shopify_shop
    from public.shop_imports i join public.shops s on s.id = i.shop_id where i.id = p_import and i.status = 'running';
  if v_shop_key is null then raise exception 'import_not_running'; end if;
  perform public.lock_shop_for_ingestion(v_shop_key);
  if public.ingest_batch_size(p_orders, p_lines) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  select count(*) filter (where x.processed_at >= v_start),
         count(*) filter (where x.processed_at < v_start and (
           exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'customer'
                    and x.customer_digest is not null and s.subject_digest = decode(x.customer_digest, 'hex'))
           or exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'order'
                    and x.order_digest is not null and s.subject_digest = decode(x.order_digest, 'hex'))))
    into v_in_window, v_suppressed
    from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(processed_at timestamptz, customer_digest text, order_digest text);

  insert into public.history_stage_orders (import_id, order_shopify_id, processed_at, currency, subtotal, total_discounts, total_tax,
    total_shipping, total_price, total_refunded, customer_digest, is_test, cancelled)
  select p_import, x.shopify_id, x.processed_at, x.currency, coalesce(x.subtotal, 0), coalesce(x.total_discounts, 0), coalesce(x.total_tax, 0),
         coalesce(x.total_shipping, 0), coalesce(x.total_price, 0), coalesce(x.total_refunded, 0),
         case when x.customer_digest is null
                or exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'customer'
                            and s.subject_digest = decode(x.customer_digest, 'hex'))
                or exists (select 1 from public.redaction_suppressions s where s.shopify_shop_id = v_shopify_shop and s.subject_type = 'order'
                            and x.order_digest is not null and s.subject_digest = decode(x.order_digest, 'hex'))
              then null else decode(x.customer_digest, 'hex') end,
         coalesce(x.is_test, false), x.cancelled_at is not null
    from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(shopify_id bigint, processed_at timestamptz, currency text, subtotal numeric,
         total_discounts numeric, total_tax numeric, total_shipping numeric, total_price numeric, total_refunded numeric,
         customer_digest text, order_digest text, is_test boolean, cancelled_at timestamptz)
   where x.processed_at < v_start
  on conflict do nothing;
  get diagnostics v_orders = row_count;

  insert into public.history_stage_lines (import_id, line_shopify_id, order_shopify_id, product_shopify_id, quantity, gross, discount, refunded)
  select p_import, l.shopify_id, l.order_shopify_id, l.product_shopify_id, coalesce(l.quantity, 0), coalesce(l.unit_price, 0) * coalesce(l.quantity, 0),
         coalesce(l.total_discount, 0), coalesce(l.refunded_quantity, 0)
    from jsonb_to_recordset(coalesce(p_lines, '[]')) as l(shopify_id bigint, order_shopify_id bigint, product_shopify_id bigint, quantity integer,
         unit_price numeric, total_discount numeric, refunded_quantity integer)
   where exists (select 1 from public.history_stage_orders o where o.import_id = p_import and o.order_shopify_id = l.order_shopify_id)
  on conflict do nothing;
  get diagnostics v_lines = row_count;

  return jsonb_build_object('orders', v_orders, 'lines', v_lines, 'in_window', v_in_window, 'suppressed', v_suppressed);
end;
$$;

create or replace function public.summarise_history_month(p_import uuid, p_month date, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop_key integer;
  v_from timestamptz := date_trunc('month', p_month);
  v_to timestamptz := date_trunc('month', p_month) + interval '1 month';
  v_products integer := 0;
  v_store integer := 0;
begin
  select s.shop_key into v_shop_key from public.shop_imports i join public.shops s on s.id = i.shop_id where i.id = p_import and i.status = 'running';
  if v_shop_key is null then raise exception 'import_not_running'; end if;
  if v_to > public.retention_window_start() then raise exception 'month_inside_retained_window'; end if;
  perform public.lock_shop_for_ingestion(v_shop_key);

  with firsts as (
    select customer_digest, min(processed_at) as first_at from public.history_stage_orders
     where import_id = p_import and customer_digest is not null and not is_test and not cancelled group by 1
  ), orders as (
    select o.*, (o.customer_digest is not null and f.first_at = o.processed_at) as first_order
      from public.history_stage_orders o left join firsts f on f.customer_digest = o.customer_digest
     where o.import_id = p_import and o.processed_at >= v_from and o.processed_at < v_to and not o.is_test and not o.cancelled
  )
  insert into public.product_monthly_metrics (shop_key, product_shopify_id, month, calc_version, currency, orders, units, gross_sales, discounts,
    refunded_units, returned_units, customers, first_time_customers, finalized_at)
  select v_shop_key, l.product_shopify_id, v_from::date, p_calc_version, max(o.currency), count(distinct o.order_shopify_id), sum(l.quantity),
         sum(l.gross), sum(l.discount), sum(l.refunded), 0, count(distinct o.customer_digest),
         count(distinct o.customer_digest) filter (where o.first_order), now()
    from public.history_stage_lines l join orders o on o.order_shopify_id = l.order_shopify_id
   where l.import_id = p_import and l.product_shopify_id is not null
   group by l.product_shopify_id
  having count(distinct o.order_shopify_id) > 0 or sum(l.quantity) > 0 or sum(l.refunded) > 0
  on conflict do nothing;
  get diagnostics v_products = row_count;

  with firsts as (
    select customer_digest, min(processed_at) as first_at from public.history_stage_orders
     where import_id = p_import and customer_digest is not null and not is_test and not cancelled group by 1
  ), orders as (
    select o.*, (o.customer_digest is not null and f.first_at = o.processed_at) as first_order
      from public.history_stage_orders o left join firsts f on f.customer_digest = o.customer_digest
     where o.import_id = p_import and o.processed_at >= v_from and o.processed_at < v_to and not o.is_test and not o.cancelled
  )
  insert into public.store_monthly_metrics (shop_key, month, calc_version, currency, orders, units, subtotal, total_discounts, total_tax,
    total_shipping, total_price, total_refunded, customers, new_customers, finalized_at)
  select v_shop_key, v_from::date, p_calc_version, max(o.currency), count(*),
         coalesce((select sum(l.quantity) from public.history_stage_lines l where l.import_id = p_import
                    and l.order_shopify_id in (select order_shopify_id from orders)), 0),
         sum(o.subtotal), sum(o.total_discounts), sum(o.total_tax), sum(o.total_shipping), sum(o.total_price), sum(o.total_refunded),
         count(distinct o.customer_digest), count(distinct o.customer_digest) filter (where o.first_order), now()
    from orders o
  having count(*) > 0
  on conflict do nothing;
  get diagnostics v_store = row_count;

  return jsonb_build_object('product_months', v_products, 'store_months', v_store);
end;
$$;

create or replace function public.discard_history_stage(p_import uuid, p_limit integer default 20000)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lines integer := 0;
  v_orders integer := 0;
begin
  delete from public.history_stage_lines where ctid in (select ctid from public.history_stage_lines where import_id = p_import limit p_limit);
  get diagnostics v_lines = row_count;
  if v_lines < p_limit then
    delete from public.history_stage_orders where ctid in (select ctid from public.history_stage_orders where import_id = p_import limit p_limit - v_lines);
    get diagnostics v_orders = row_count;
  end if;
  return jsonb_build_object('deleted', v_lines + v_orders,
    'remaining', (select count(*) from public.history_stage_lines where import_id = p_import)
               + (select count(*) from public.history_stage_orders where import_id = p_import));
end;
$$;

create or replace function public.ingest_orders(p_shop_key integer, p_orders jsonb, p_line_items jsonb, p_refunds jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shopify_shop bigint;
  v_cutoff timestamptz := public.retention_window_start();
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

drop function public.shop_window_start(integer);
alter table public.customers drop column history_first_order_at;
alter table public.shop_imports drop column window_start;

revoke all on function public.stage_history_orders(uuid, jsonb, jsonb), public.summarise_history_month(uuid, date, integer),
  public.discard_history_stage(uuid, integer) from public, anon, authenticated;
grant execute on function public.stage_history_orders(uuid, jsonb, jsonb), public.summarise_history_month(uuid, date, integer),
  public.discard_history_stage(uuid, integer) to service_role;
