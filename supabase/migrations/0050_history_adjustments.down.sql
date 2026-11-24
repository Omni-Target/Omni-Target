-- Reverts 0050: the earlier functions, then the rows only 0050 can make (cancellation adjustments, customer-only
-- adjustments, cancellation ledger entries) and the columns and constraints. Effective summaries then show customer
-- counts as finalised again, and cancelled history orders as counted, as before 0050.
create or replace function public.summarise_detail_month(p_shop_key integer, p_month date, p_calc_version integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_final_before date := date_trunc('month', now() - interval '120 days')::date;
  v_cohort_final_before date := date_trunc('month', now() - interval '485 days')::date;
  v_final boolean;
  v_state text;
  v_products integer := 0;
  v_store integer := 0;
  v_cohorts integer := 0;
  v_product_adjustments integer := 0;
  v_store_adjustments integer := 0;
  v_dated integer := 0;
begin
  if p_shop_key is null or v_month is null or coalesce(p_calc_version, 0) < 1 then raise exception 'aggregate_range_invalid'; end if;
  -- One refresh of a shop's month at a time, so a final month's adjustments are recorded once.
  perform pg_advisory_xact_lock(hashtextextended('summary_month:' || p_shop_key || ':' || v_month || ':' || p_calc_version, 0));
  -- Cleared first: a change committed after this point marks the month again.
  delete from public.summary_dirty_months where shop_key = p_shop_key and month = v_month;

  select exists (select 1 from public.store_monthly_metrics where shop_key = p_shop_key and month = v_month and calc_version = p_calc_version
                  and finalized_at is not null) into v_final;

  if not v_final then
    delete from public.product_monthly_metrics
     where shop_key = p_shop_key and calc_version = p_calc_version and month = v_month and finalized_at is null;
    insert into public.product_monthly_metrics (shop_key, product_shopify_id, month, calc_version, currency, orders, units, gross_sales,
      discounts, refunded_units, returned_units, customers, first_time_customers, finalized_at)
    select p_shop_key, d.product_shopify_id, v_month, p_calc_version, d.currency, d.orders, d.units, d.gross_sales, d.discounts,
           d.refunded_units, d.returned_units, d.customers, d.first_time_customers, case when v_month < v_final_before then now() end
      from public.detail_product_month(p_shop_key, v_month) d
    on conflict (shop_key, product_shopify_id, month, calc_version) do nothing;
    get diagnostics v_products = row_count;

    delete from public.store_monthly_metrics
     where shop_key = p_shop_key and calc_version = p_calc_version and month = v_month and finalized_at is null;
    insert into public.store_monthly_metrics (shop_key, month, calc_version, currency, orders, units, subtotal, total_discounts,
      total_tax, total_shipping, total_price, total_refunded, customers, new_customers, finalized_at)
    select p_shop_key, v_month, p_calc_version, d.currency, d.orders, d.units, d.subtotal, d.total_discounts, d.total_tax,
           d.total_shipping, d.total_price, d.total_refunded, d.customers, d.new_customers, case when v_month < v_final_before then now() end
      from public.detail_store_month(p_shop_key, v_month) d
    on conflict (shop_key, month, calc_version) do nothing;
    get diagnostics v_store = row_count;
    v_state := case when v_store = 0 then 'empty' when v_month < v_final_before then 'finalised' else 'open' end;

  elsif v_month < public.shop_window_start(p_shop_key)
     or not exists (select 1 from public.orders where shop_key = p_shop_key and processed_at >= v_month and processed_at < v_month + interval '1 month') then
    -- History, or detail no longer held: the final summary stands as it is.
    v_state := 'frozen';

  else
    -- Final: record what changed since finalisation (final summary plus earlier adjustments) as adjustments.
    insert into public.product_monthly_adjustments (shop_key, product_shopify_id, month, calc_version, currency, reason, orders, units,
      gross_sales, discounts, refunded_units, returned_units)
    select p_shop_key, d.product_shopify_id, v_month, p_calc_version, d.currency,
           case when d.orders = 0 and d.units = 0 and d.gross_sales = 0 and d.discounts = 0 then
                  case when d.refunded_units <> 0 and d.returned_units <> 0 then 'refund_return'
                       when d.refunded_units <> 0 then 'refund' else 'return' end
                else 'correction' end,
           d.orders, d.units, d.gross_sales, d.discounts, d.refunded_units, d.returned_units
      from (select coalesce(c.product_shopify_id, p.product_shopify_id) as product_shopify_id, coalesce(c.currency, p.currency) as currency,
                   coalesce(c.orders, 0) - coalesce(p.orders, 0) as orders, coalesce(c.units, 0) - coalesce(p.units, 0) as units,
                   coalesce(c.gross_sales, 0) - coalesce(p.gross_sales, 0) as gross_sales, coalesce(c.discounts, 0) - coalesce(p.discounts, 0) as discounts,
                   coalesce(c.refunded_units, 0) - coalesce(p.refunded_units, 0) as refunded_units,
                   coalesce(c.returned_units, 0) - coalesce(p.returned_units, 0) as returned_units
              from public.detail_product_month(p_shop_key, v_month) c
              full join (select b.product_shopify_id, max(b.currency) as currency, sum(b.orders) as orders, sum(b.units) as units,
                                sum(b.gross_sales) as gross_sales, sum(b.discounts) as discounts, sum(b.refunded_units) as refunded_units,
                                sum(b.returned_units) as returned_units
                           from (select product_shopify_id, currency, orders, units, gross_sales, discounts, refunded_units, returned_units
                                   from public.product_monthly_metrics where shop_key = p_shop_key and month = v_month and calc_version = p_calc_version
                                 union all
                                 select product_shopify_id, currency, orders, units, gross_sales, discounts, refunded_units, returned_units
                                   from public.product_monthly_adjustments where shop_key = p_shop_key and month = v_month and calc_version = p_calc_version) b
                          group by b.product_shopify_id) p on p.product_shopify_id = c.product_shopify_id) d
     where d.orders <> 0 or d.units <> 0 or d.gross_sales <> 0 or d.discounts <> 0 or d.refunded_units <> 0 or d.returned_units <> 0;
    get diagnostics v_product_adjustments = row_count;

    insert into public.store_monthly_adjustments (shop_key, month, calc_version, currency, reason, orders, units, subtotal, total_discounts,
      total_tax, total_shipping, total_price, total_refunded)
    select p_shop_key, v_month, p_calc_version, d.currency,
           case when d.orders = 0 and d.units = 0 and d.subtotal = 0 and d.total_discounts = 0 and d.total_tax = 0 and d.total_shipping = 0
                     and d.total_price = 0 then 'refund' else 'correction' end,
           d.orders, d.units, d.subtotal, d.total_discounts, d.total_tax, d.total_shipping, d.total_price, d.total_refunded
      from (select coalesce(c.currency, p.currency) as currency,
                   coalesce(c.orders, 0) - coalesce(p.orders, 0) as orders, coalesce(c.units, 0) - coalesce(p.units, 0) as units,
                   coalesce(c.subtotal, 0) - coalesce(p.subtotal, 0) as subtotal,
                   coalesce(c.total_discounts, 0) - coalesce(p.total_discounts, 0) as total_discounts,
                   coalesce(c.total_tax, 0) - coalesce(p.total_tax, 0) as total_tax,
                   coalesce(c.total_shipping, 0) - coalesce(p.total_shipping, 0) as total_shipping,
                   coalesce(c.total_price, 0) - coalesce(p.total_price, 0) as total_price,
                   coalesce(c.total_refunded, 0) - coalesce(p.total_refunded, 0) as total_refunded
              from (select 1 as k, s.* from public.detail_store_month(p_shop_key, v_month) s) c
              full join (select 1 as k, max(b.currency) as currency, sum(b.orders) as orders, sum(b.units) as units, sum(b.subtotal) as subtotal,
                                sum(b.total_discounts) as total_discounts, sum(b.total_tax) as total_tax, sum(b.total_shipping) as total_shipping,
                                sum(b.total_price) as total_price, sum(b.total_refunded) as total_refunded
                           from (select currency, orders, units, subtotal, total_discounts, total_tax, total_shipping, total_price, total_refunded
                                   from public.store_monthly_metrics where shop_key = p_shop_key and month = v_month and calc_version = p_calc_version
                                 union all
                                 select currency, orders, units, subtotal, total_discounts, total_tax, total_shipping, total_price, total_refunded
                                   from public.store_monthly_adjustments where shop_key = p_shop_key and month = v_month and calc_version = p_calc_version) b
                         having count(*) > 0) p on p.k = c.k) d
     where d.orders <> 0 or d.units <> 0 or d.subtotal <> 0 or d.total_discounts <> 0 or d.total_tax <> 0 or d.total_shipping <> 0
        or d.total_price <> 0 or d.total_refunded <> 0;
    get diagnostics v_store_adjustments = row_count;
    v_state := case when v_product_adjustments + v_store_adjustments > 0 then 'adjusted' else 'unchanged' end;
  end if;

  -- The cohort first ordering in this month (0030's calculation), until it is final.
  delete from public.cohort_monthly_outcomes
   where shop_key = p_shop_key and calc_version = p_calc_version and cohort_month = v_month and finalized_at is null;
  insert into public.cohort_monthly_outcomes (shop_key, cohort_month, calc_version, currency, first_time_customers, repeat_30d,
    repeat_60d, repeat_90d, repeat_180d, repeat_365d, first_order_revenue, revenue_60d, observed_through, finalized_at)
  select p_shop_key, v_month, p_calc_version, max(f.currency), count(*),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '30 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '60 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '90 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '180 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '365 days'),
         coalesce(sum(f.total_price), 0), coalesce(sum(r60.revenue), 0), now(),
         case when v_month < v_cohort_final_before then now() end
    from public.customers c
    join public.orders f on f.shop_key = c.shop_key and f.shopify_id = c.first_order_shopify_id
    left join lateral (select min(o.processed_at) as next_at from public.orders o
                        where o.shop_key = c.shop_key and o.customer_shopify_id = c.shopify_id and o.processed_at > c.first_order_at
                          and not o.is_test and o.cancelled_at is null) nx on true
    left join lateral (select sum(o.total_price) as revenue from public.orders o
                        where o.shop_key = c.shop_key and o.customer_shopify_id = c.shopify_id
                          and o.processed_at >= c.first_order_at and o.processed_at <= c.first_order_at + interval '60 days'
                          and not o.is_test and o.cancelled_at is null) r60 on true
   where c.shop_key = p_shop_key and c.first_order_at >= v_month and c.first_order_at < v_month + interval '1 month'
  having count(*) > 0
  on conflict (shop_key, cohort_month, calc_version) do nothing;
  get diagnostics v_cohorts = row_count;

  -- Sale dates only ever widen (0030).
  update public.products p
     set first_sold_at = least(p.first_sold_at, s.first_at), last_sold_at = greatest(p.last_sold_at, s.last_at)
    from (select li.product_shopify_id, min(o.processed_at) as first_at, max(o.processed_at) as last_at
            from public.order_line_items li join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
           where li.shop_key = p_shop_key and li.product_shopify_id is not null and not o.is_test and o.cancelled_at is null
             and o.processed_at >= v_month and o.processed_at < v_month + interval '1 month'
           group by 1) s
   where p.shop_key = p_shop_key and p.shopify_id = s.product_shopify_id
     and (p.first_sold_at is distinct from least(p.first_sold_at, s.first_at) or p.last_sold_at is distinct from greatest(p.last_sold_at, s.last_at));
  get diagnostics v_dated = row_count;

  return jsonb_build_object('month', v_month, 'state', v_state, 'product_months', v_products, 'store_months', v_store,
    'cohort_months', v_cohorts, 'products_dated', v_dated, 'product_adjustments', v_product_adjustments,
    'store_adjustments', v_store_adjustments);
end;
$$;

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

create or replace function public.product_months_effective(p_shop_key integer, p_from date, p_to date, p_calc_version integer default 1)
returns table (month date, product_shopify_id bigint, currency text, orders integer, units integer, gross_sales numeric, discounts numeric,
               refunded_units integer, returned_units integer, customers integer, first_time_customers integer, final boolean, adjustments integer)
language sql stable security definer set search_path = public, pg_temp as $$
  with keys as (
    select month, product_shopify_id from public.product_monthly_metrics
     where shop_key = p_shop_key and calc_version = p_calc_version and month between date_trunc('month', p_from)::date and p_to
    union
    select month, product_shopify_id from public.product_monthly_adjustments
     where shop_key = p_shop_key and calc_version = p_calc_version and month between date_trunc('month', p_from)::date and p_to
  ), adjusted as (
    select month, product_shopify_id, max(currency) as currency, sum(orders) as orders, sum(units) as units, sum(gross_sales) as gross_sales,
           sum(discounts) as discounts, sum(refunded_units) as refunded_units, sum(returned_units) as returned_units, count(*) as n
      from public.product_monthly_adjustments
     where shop_key = p_shop_key and calc_version = p_calc_version and month between date_trunc('month', p_from)::date and p_to
     group by 1, 2
  )
  select k.month, k.product_shopify_id, coalesce(m.currency, a.currency),
         (coalesce(m.orders, 0) + coalesce(a.orders, 0))::integer, (coalesce(m.units, 0) + coalesce(a.units, 0))::integer,
         coalesce(m.gross_sales, 0) + coalesce(a.gross_sales, 0), coalesce(m.discounts, 0) + coalesce(a.discounts, 0),
         (coalesce(m.refunded_units, 0) + coalesce(a.refunded_units, 0))::integer, (coalesce(m.returned_units, 0) + coalesce(a.returned_units, 0))::integer,
         coalesce(m.customers, 0), coalesce(m.first_time_customers, 0),
         -- A product known only from adjustments belongs to a final month (adjustments exist only there).
         m.product_shopify_id is null or m.finalized_at is not null, coalesce(a.n, 0)::integer
    from keys k
    left join public.product_monthly_metrics m
      on m.shop_key = p_shop_key and m.calc_version = p_calc_version and m.month = k.month and m.product_shopify_id = k.product_shopify_id
    left join adjusted a on a.month = k.month and a.product_shopify_id = k.product_shopify_id
   order by k.month, k.product_shopify_id;
$$;

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

delete from public.store_monthly_adjustments where reason = 'cancellation'
   or (orders = 0 and units = 0 and subtotal = 0 and total_discounts = 0 and total_tax = 0 and total_shipping = 0 and total_price = 0 and total_refunded = 0);
delete from public.product_monthly_adjustments where reason = 'cancellation'
   or (orders = 0 and units = 0 and gross_sales = 0 and discounts = 0 and refunded_units = 0 and returned_units = 0);
delete from public.history_arrivals where subject = 'cancellation';

alter table public.history_arrivals
  drop constraint history_arrivals_subject_check,
  add constraint history_arrivals_subject_check check (subject in ('order', 'refund'));
alter table public.product_monthly_adjustments
  drop constraint product_monthly_adjustments_reason_check,
  add constraint product_monthly_adjustments_reason_check check (reason in ('refund', 'return', 'refund_return', 'correction')),
  drop constraint product_monthly_adjustments_check,
  add constraint product_monthly_adjustments_check check (orders <> 0 or units <> 0 or gross_sales <> 0 or discounts <> 0
    or refunded_units <> 0 or returned_units <> 0),
  drop column customers, drop column first_time_customers;
alter table public.store_monthly_adjustments
  drop constraint store_monthly_adjustments_reason_check,
  add constraint store_monthly_adjustments_reason_check check (reason in ('refund', 'correction')),
  drop constraint store_monthly_adjustments_check,
  add constraint store_monthly_adjustments_check check (orders <> 0 or units <> 0 or subtotal <> 0 or total_discounts <> 0 or total_tax <> 0
    or total_shipping <> 0 or total_price <> 0 or total_refunded <> 0),
  drop column customers, drop column new_customers;
