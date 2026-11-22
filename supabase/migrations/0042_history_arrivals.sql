-- Phase 2: late arrivals in history months (decision of 2026-11-22).
--
-- Months before the retained window hold only their final summaries, so maintenance cannot recompute
-- them (0036: "frozen"), and an order or refund that reaches Shopify after such a month was summarised
-- used to be counted nowhere. Now the incremental sync passes the orders it fetched from before the
-- window, and apply_history_arrivals records what the summaries cannot already contain:
--  - an order created after its month closed, with the refunds it has then: a 'correction' adjustment;
--  - a refund created after its order's month closed: a 'refund' adjustment (refunded amount, and units
--    from the refund's own line items).
-- A month closes when its summary stopped taking changes: when it was summarised from history (its
-- final row's finalized_at), or when it left the window (month + 25 months) if it was inside the window
-- once; a history month that had no orders when it was summarised has no summary, so nothing in it
-- was counted. Customer counts are not adjusted, as in 0036.
--
-- history_arrivals remembers what was applied, as keyed digests (no order IDs, no customer data), so
-- webhooks, the reconcile and replays count each order and refund once. While an import is in progress
-- the arrivals wait (the caller retries), and an import never writes a fresh summary for a month that
-- has adjustments. store_months_effective now also returns months known only from adjustments, as
-- product_months_effective already did.
--
-- Changes no existing rows.

create table public.history_arrivals (
  shop_key    integer not null references public.shops (shop_key),
  subject     text not null check (subject in ('order', 'refund')),
  digest      bytea not null check (octet_length(digest) = 32),
  month       date not null check (month = date_trunc('month', month)::date),
  applied_at  timestamptz not null default now(),
  primary key (shop_key, subject, digest)
);

-- When a history month stopped taking changes; '-infinity' for a history month that was never summarised.
create or replace function public.history_month_closed_at(p_shop_key integer, p_month date, p_first_window timestamptz, p_calc_version integer)
returns timestamptz language sql stable set search_path = public, pg_temp as $$
  select case
           when m.month is not null then greatest(coalesce(m.finalized_at, p_month::timestamptz + interval '25 months'), p_month::timestamptz + interval '25 months')
           when p_month < p_first_window then '-infinity'::timestamptz
           else p_month::timestamptz + interval '25 months'
         end
    from (select 1) one
    left join public.store_monthly_metrics m on m.shop_key = p_shop_key and m.month = p_month and m.calc_version = p_calc_version;
$$;

-- Records late arrivals among orders the sync fetched (as ingest_orders receives them, plus refund digests
-- and refund line items). Orders inside the window are ignored here.
create or replace function public.apply_history_arrivals(p_shop_key integer, p_orders jsonb, p_line_items jsonb, p_refunds jsonb,
  p_refund_lines jsonb, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop uuid;
  v_start timestamptz;
  v_first_window timestamptz;
  v_history integer;
  v_orders bytea[];
  v_refunds bytea[];
  v_store integer := 0;
  v_products integer := 0;
  v_n integer;
begin
  if public.ingest_batch_size(p_orders, p_line_items, p_refunds, p_refund_lines) > 4000 then raise exception 'ingest_batch_too_large'; end if;
  perform public.lock_shop_for_ingestion(p_shop_key);
  v_start := public.shop_window_start(p_shop_key);
  select count(*) into v_history from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(processed_at timestamptz) where x.processed_at < v_start;
  if v_history = 0 then return jsonb_build_object('history_orders', 0); end if;

  select s.id into v_shop from public.shops s where s.shop_key = p_shop_key;
  -- An import in progress may still summarise these months: the caller tries again later.
  if exists (select 1 from public.shop_imports i where i.shop_id = v_shop and i.status in ('requested', 'dispatched', 'running')) then
    return jsonb_build_object('history_orders', v_history, 'deferred', true);
  end if;
  select coalesce(i.window_start, date_trunc('month', i.started_at - interval '24 months')) into v_first_window
    from public.shop_imports i
   where i.shop_id = v_shop and i.status in ('succeeded', 'partial') and i.coverage #>> '{domains,orders,status}' = 'succeeded'
   order by i.started_at limit 1;
  -- Before a complete orders import there are no history summaries: the import makes them.
  if v_first_window is null then return jsonb_build_object('history_orders', v_history, 'skipped', 'not_imported'); end if;

  -- Late orders: created after their month closed, and not test or cancelled.
  with incoming as (
    select distinct on (x.shopify_id) x.*, date_trunc('month', x.processed_at)::date as month
      from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(shopify_id bigint, order_digest text, shopify_created_at timestamptz,
           processed_at timestamptz, cancelled_at timestamptz, is_test boolean)
     where x.processed_at < v_start and x.order_digest is not null
  ), claimed as (
    insert into public.history_arrivals as h (shop_key, subject, digest, month)
    select p_shop_key, 'order', decode(i.order_digest, 'hex'), i.month from incoming i
     where not coalesce(i.is_test, false) and i.cancelled_at is null
       and i.shopify_created_at > public.history_month_closed_at(p_shop_key, i.month, v_first_window, p_calc_version)
    on conflict do nothing
    returning h.digest
  )
  select coalesce(array_agg(digest), '{}') into v_orders from claimed;

  if cardinality(v_orders) > 0 then
    insert into public.store_monthly_adjustments (shop_key, month, calc_version, currency, reason, orders, units, subtotal, total_discounts,
      total_tax, total_shipping, total_price, total_refunded)
    select p_shop_key, o.month, p_calc_version, max(o.currency), 'correction', count(*)::integer, coalesce(sum(u.units), 0)::integer,
           sum(o.subtotal), sum(o.total_discounts), sum(o.total_tax), sum(o.total_shipping), sum(o.total_price), sum(o.total_refunded)
      from (select distinct on (x.shopify_id) x.*, date_trunc('month', x.processed_at)::date as month
              from jsonb_to_recordset(p_orders) as x(shopify_id bigint, order_digest text, processed_at timestamptz, currency text, subtotal numeric,
                   total_discounts numeric, total_tax numeric, total_shipping numeric, total_price numeric, total_refunded numeric)
             where x.processed_at < v_start and decode(x.order_digest, 'hex') = any (v_orders)) o
      left join (select l.order_shopify_id, sum(l.quantity) as units
                   from (select distinct on (y.shopify_id) y.* from jsonb_to_recordset(coalesce(p_line_items, '[]')) as y(shopify_id bigint,
                         order_shopify_id bigint, quantity integer)) l group by 1) u on u.order_shopify_id = o.shopify_id
     group by o.month;
    get diagnostics v_n = row_count;
    v_store := v_store + v_n;

    insert into public.product_monthly_adjustments (shop_key, product_shopify_id, month, calc_version, currency, reason, orders, units,
      gross_sales, discounts, refunded_units, returned_units)
    select p_shop_key, l.product_shopify_id, o.month, p_calc_version, max(o.currency), 'correction', count(distinct o.shopify_id)::integer,
           sum(l.quantity)::integer, sum(l.unit_price * l.quantity), sum(l.total_discount), sum(l.refunded_quantity)::integer, 0
      from (select distinct on (x.shopify_id) x.*, date_trunc('month', x.processed_at)::date as month
              from jsonb_to_recordset(p_orders) as x(shopify_id bigint, order_digest text, processed_at timestamptz, currency text)
             where x.processed_at < v_start and decode(x.order_digest, 'hex') = any (v_orders)) o
      join (select distinct on (y.shopify_id) y.* from jsonb_to_recordset(coalesce(p_line_items, '[]')) as y(shopify_id bigint,
            order_shopify_id bigint, product_shopify_id bigint, quantity integer, unit_price numeric, total_discount numeric,
            refunded_quantity integer)) l on l.order_shopify_id = o.shopify_id
     where l.product_shopify_id is not null
     group by l.product_shopify_id, o.month;
    get diagnostics v_n = row_count;
    v_products := v_products + v_n;

    -- The refunds a late order has now are in its correction; later sightings of them are not late refunds.
    insert into public.history_arrivals (shop_key, subject, digest, month)
    select p_shop_key, 'refund', decode(r.refund_digest, 'hex'), date_trunc('month', o.processed_at)::date
      from jsonb_to_recordset(coalesce(p_refunds, '[]')) as r(order_shopify_id bigint, refund_digest text)
      join jsonb_to_recordset(p_orders) as o(shopify_id bigint, order_digest text, processed_at timestamptz) on o.shopify_id = r.order_shopify_id
     where r.refund_digest is not null and o.processed_at < v_start and decode(o.order_digest, 'hex') = any (v_orders)
    on conflict do nothing;
  end if;

  -- Late refunds: on an order the summaries count (from before its month closed, or applied as a late order),
  -- created after the month closed.
  with incoming as (
    select distinct on (x.shopify_id) x.*, date_trunc('month', x.processed_at)::date as month,
           public.history_month_closed_at(p_shop_key, date_trunc('month', x.processed_at)::date, v_first_window, p_calc_version) as closed_at
      from jsonb_to_recordset(coalesce(p_orders, '[]')) as x(shopify_id bigint, order_digest text, shopify_created_at timestamptz,
           processed_at timestamptz, cancelled_at timestamptz, is_test boolean)
     where x.processed_at < v_start and x.order_digest is not null
  ), counted as (
    select i.* from incoming i
     where not coalesce(i.is_test, false) and i.cancelled_at is null
       and (i.shopify_created_at <= i.closed_at
            or exists (select 1 from public.history_arrivals h
                        where h.shop_key = p_shop_key and h.subject = 'order' and h.digest = decode(i.order_digest, 'hex')))
  ), late as (
    select distinct on (r.shopify_id) r.refund_digest, c.month
      from jsonb_to_recordset(coalesce(p_refunds, '[]')) as r(shopify_id bigint, order_shopify_id bigint, refund_digest text,
           shopify_created_at timestamptz)
      join counted c on c.shopify_id = r.order_shopify_id
     where r.refund_digest is not null and r.shopify_created_at > c.closed_at
  ), claimed as (
    insert into public.history_arrivals as h (shop_key, subject, digest, month)
    select p_shop_key, 'refund', decode(l.refund_digest, 'hex'), l.month from late l
    on conflict do nothing
    returning h.digest
  )
  select coalesce(array_agg(digest), '{}') into v_refunds from claimed;

  if cardinality(v_refunds) > 0 then
    insert into public.store_monthly_adjustments (shop_key, month, calc_version, currency, reason, total_refunded)
    select p_shop_key, date_trunc('month', o.processed_at)::date, p_calc_version, max(o.currency), 'refund', sum(r.total_refunded)
      from (select distinct on (y.shopify_id) y.* from jsonb_to_recordset(p_refunds) as y(shopify_id bigint, order_shopify_id bigint,
            refund_digest text, total_refunded numeric)) r
      join (select distinct on (x.shopify_id) x.* from jsonb_to_recordset(p_orders) as x(shopify_id bigint, processed_at timestamptz,
            currency text)) o on o.shopify_id = r.order_shopify_id
     where decode(r.refund_digest, 'hex') = any (v_refunds)
     group by 2
    having sum(r.total_refunded) <> 0;
    get diagnostics v_n = row_count;
    v_store := v_store + v_n;

    insert into public.product_monthly_adjustments (shop_key, product_shopify_id, month, calc_version, currency, reason, refunded_units)
    select p_shop_key, rl.product_shopify_id, date_trunc('month', o.processed_at)::date, p_calc_version, max(o.currency), 'refund',
           sum(rl.quantity)::integer
      from jsonb_to_recordset(coalesce(p_refund_lines, '[]')) as rl(refund_shopify_id bigint, product_shopify_id bigint, quantity integer)
      join (select distinct on (y.shopify_id) y.* from jsonb_to_recordset(p_refunds) as y(shopify_id bigint, order_shopify_id bigint,
            refund_digest text)) r on r.shopify_id = rl.refund_shopify_id
      join (select distinct on (x.shopify_id) x.* from jsonb_to_recordset(p_orders) as x(shopify_id bigint, processed_at timestamptz,
            currency text)) o on o.shopify_id = r.order_shopify_id
     where rl.product_shopify_id is not null and decode(r.refund_digest, 'hex') = any (v_refunds)
     group by rl.product_shopify_id, 3
    having sum(rl.quantity) <> 0;
    get diagnostics v_n = row_count;
    v_products := v_products + v_n;
  end if;

  return jsonb_build_object('history_orders', v_history, 'orders_applied', cardinality(v_orders), 'refunds_applied', cardinality(v_refunds),
    'store_adjustments', v_store, 'product_adjustments', v_products);
end;
$$;

-- 0035's history summary, keeping the summary of a month that has adjustments.
create or replace function public.summarise_history_month(p_import uuid, p_run_id text, p_month date, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop_key integer;
  v_start timestamptz;
  v_from timestamptz := date_trunc('month', p_month);
  v_to timestamptz := date_trunc('month', p_month) + interval '1 month';
  v_products integer := 0;
  v_store integer := 0;
begin
  select s.shop_key, coalesce(i.window_start, public.retention_window_start()) into v_shop_key, v_start
    from public.shop_imports i join public.shops s on s.id = i.shop_id
   where i.id = p_import and i.status = 'running' and i.trigger_run_id = p_run_id
     for key share of i;
  if v_shop_key is null then raise exception 'import_not_running'; end if;
  if v_to > v_start then raise exception 'month_inside_retained_window'; end if;
  perform public.lock_shop_for_ingestion(v_shop_key);
  -- A month with adjustments (late arrivals, or changes after it was final) keeps the summary it has: a
  -- fresh one from this import would count those changes a second time (0042).
  if exists (select 1 from public.store_monthly_adjustments a where a.shop_key = v_shop_key and a.month = v_from::date and a.calc_version = p_calc_version)
     or exists (select 1 from public.product_monthly_adjustments a where a.shop_key = v_shop_key and a.month = v_from::date and a.calc_version = p_calc_version) then
    return jsonb_build_object('product_months', 0, 'store_months', 0, 'kept', true);
  end if;

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

-- 0036's effective store months, with months known only from adjustments.
create or replace function public.store_months_effective(p_shop_key integer, p_from date, p_to date, p_calc_version integer default 1)
returns table (month date, currency text, orders integer, units integer, subtotal numeric, total_discounts numeric, total_tax numeric,
               total_shipping numeric, total_price numeric, total_refunded numeric, customers integer, new_customers integer,
               final boolean, adjustments integer)
language sql stable security definer set search_path = public, pg_temp as $$
  with adjusted as (
    select month, max(currency) as currency, sum(orders) as orders, sum(units) as units, sum(subtotal) as subtotal,
           sum(total_discounts) as total_discounts, sum(total_tax) as total_tax, sum(total_shipping) as total_shipping,
           sum(total_price) as total_price, sum(total_refunded) as total_refunded, count(*) as n
      from public.store_monthly_adjustments
     where shop_key = p_shop_key and calc_version = p_calc_version and month between date_trunc('month', p_from)::date and p_to
     group by 1
  ), keys as (
    select month from public.store_monthly_metrics
     where shop_key = p_shop_key and calc_version = p_calc_version and month between date_trunc('month', p_from)::date and p_to
    union
    select month from adjusted
  )
  select k.month, coalesce(m.currency, a.currency), (coalesce(m.orders, 0) + coalesce(a.orders, 0))::integer,
         (coalesce(m.units, 0) + coalesce(a.units, 0))::integer,
         coalesce(m.subtotal, 0) + coalesce(a.subtotal, 0), coalesce(m.total_discounts, 0) + coalesce(a.total_discounts, 0),
         coalesce(m.total_tax, 0) + coalesce(a.total_tax, 0), coalesce(m.total_shipping, 0) + coalesce(a.total_shipping, 0),
         coalesce(m.total_price, 0) + coalesce(a.total_price, 0), coalesce(m.total_refunded, 0) + coalesce(a.total_refunded, 0),
         coalesce(m.customers, 0), coalesce(m.new_customers, 0),
         -- A month known only from adjustments is final (adjustments exist only there), like 0036's product months.
         m.month is null or m.finalized_at is not null, coalesce(a.n, 0)::integer
    from keys k
    left join public.store_monthly_metrics m on m.shop_key = p_shop_key and m.calc_version = p_calc_version and m.month = k.month
    left join adjusted a on a.month = k.month
   order by k.month;
$$;

-- 0036's deletion helpers, with the arrivals.
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

alter table public.history_arrivals enable row level security;
revoke all on table public.history_arrivals from public, anon, authenticated, service_role;
grant select on table public.history_arrivals to service_role;

revoke all on function public.history_month_closed_at(integer, date, timestamptz, integer) from public, anon, authenticated, service_role;
revoke all on function public.apply_history_arrivals(integer, jsonb, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;
grant execute on function public.apply_history_arrivals(integer, jsonb, jsonb, jsonb, jsonb, integer) to service_role;
