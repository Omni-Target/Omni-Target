-- 0036: summary maintenance (Phase 2, task 8; decision 6).
--
--  - refresh_summary_month refreshes exactly one month of one shop per call
--    (the 8 s statement timeout): an open month is rebuilt from detail, a
--    month 120 days old is finalised, and a final month is never rewritten.
--  - Late refunds, returns and corrections to a final month inside the
--    retained window are recorded as adjustments: the difference between the
--    month recomputed from detail and its final summary plus the adjustments
--    already recorded. Effective totals (final + adjustments) therefore equal
--    a full recomputation. Customer counts stay as finalised: after
--    finalisation they change only through redaction or merges, which are not
--    business corrections. Final months before the window, or with no detail
--    left (history, or pruned detail), are left as they are.
--  - Changed months are tracked: order changes (Shopify's updated_at or a
--    measured field; not customer redaction) and return lines mark their
--    month in summary_dirty_months, cleared when the month is refreshed.
--  - summary_months_due lists what the scheduled maintenance task refreshes:
--    changed months, and every month whose summary or cohort can still
--    change (485 days), for shops open for ingestion whose orders were fully
--    imported and that have no import in progress.
--  - A trigger refuses any update to a final summary row or an adjustment.
--  - refresh_monthly_aggregates (0030) remains for operations and tests over
--    a range of months, through the same per-month calculation.
--
-- Changes no existing rows.

create table public.product_monthly_adjustments (
  id                  bigint generated always as identity primary key,
  shop_key            integer not null references public.shops (shop_key),
  product_shopify_id  bigint not null check (product_shopify_id > 0),
  month               date not null check (month = date_trunc('month', month)::date),
  calc_version        integer not null check (calc_version > 0),
  currency            text not null check (currency ~ '^[A-Z]{3}$'),
  reason              text not null check (reason in ('refund', 'return', 'refund_return', 'correction')),
  orders              integer not null default 0,
  units               integer not null default 0,
  gross_sales         numeric(20, 4) not null default 0,
  discounts           numeric(20, 4) not null default 0,
  refunded_units      integer not null default 0,
  returned_units      integer not null default 0,
  recorded_at         timestamptz not null default now(),
  check (orders <> 0 or units <> 0 or gross_sales <> 0 or discounts <> 0 or refunded_units <> 0 or returned_units <> 0)
);
create index product_monthly_adjustments_month_idx on public.product_monthly_adjustments (shop_key, month, calc_version);

create table public.store_monthly_adjustments (
  id               bigint generated always as identity primary key,
  shop_key         integer not null references public.shops (shop_key),
  month            date not null check (month = date_trunc('month', month)::date),
  calc_version     integer not null check (calc_version > 0),
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  reason           text not null check (reason in ('refund', 'correction')),
  orders           integer not null default 0,
  units            integer not null default 0,
  subtotal         numeric(20, 4) not null default 0,
  total_discounts  numeric(20, 4) not null default 0,
  total_tax        numeric(20, 4) not null default 0,
  total_shipping   numeric(20, 4) not null default 0,
  total_price      numeric(20, 4) not null default 0,
  total_refunded   numeric(20, 4) not null default 0,
  recorded_at      timestamptz not null default now(),
  check (orders <> 0 or units <> 0 or subtotal <> 0 or total_discounts <> 0 or total_tax <> 0 or total_shipping <> 0
         or total_price <> 0 or total_refunded <> 0)
);
create index store_monthly_adjustments_month_idx on public.store_monthly_adjustments (shop_key, month, calc_version);

create table public.summary_dirty_months (
  shop_key   integer not null references public.shops (shop_key),
  month      date not null check (month = date_trunc('month', month)::date),
  marked_at  timestamptz not null default now(),
  primary key (shop_key, month)
);

-- Final summaries and adjustments never change (deletion with the shop's data remains possible).
create or replace function public.refuse_summary_update()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'summary_final' using detail = tg_table_name;
end;
$$;
create trigger product_monthly_metrics_final before update on public.product_monthly_metrics
  for each row when (old.finalized_at is not null) execute function public.refuse_summary_update();
create trigger store_monthly_metrics_final before update on public.store_monthly_metrics
  for each row when (old.finalized_at is not null) execute function public.refuse_summary_update();
create trigger cohort_monthly_outcomes_final before update on public.cohort_monthly_outcomes
  for each row when (old.finalized_at is not null) execute function public.refuse_summary_update();
create trigger product_monthly_adjustments_append_only before update on public.product_monthly_adjustments
  for each row execute function public.refuse_summary_update();
create trigger store_monthly_adjustments_append_only before update on public.store_monthly_adjustments
  for each row execute function public.refuse_summary_update();

-- Changed months. An order marks its month (old and new) when it is added, removed, or changes in Shopify
-- (updated_at) or in a measured field; customer redaction changes neither, so it marks nothing.
create or replace function public.mark_order_summary_months()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into public.summary_dirty_months (shop_key, month)
    select distinct n.shop_key, date_trunc('month', n.processed_at)::date from new_rows n
    on conflict do nothing;
  elsif tg_op = 'DELETE' then
    insert into public.summary_dirty_months (shop_key, month)
    select distinct o.shop_key, date_trunc('month', o.processed_at)::date from old_rows o
    on conflict do nothing;
  else
    with changed as (
      select o.shop_key, o.processed_at as old_at, n.processed_at as new_at
        from old_rows o join new_rows n on n.shop_key = o.shop_key and n.shopify_id = o.shopify_id
       where (o.processed_at, o.cancelled_at, o.is_test, o.currency, o.subtotal, o.total_discounts, o.total_tax, o.total_shipping,
              o.total_price, o.total_refunded, o.shopify_updated_at)
             is distinct from
             (n.processed_at, n.cancelled_at, n.is_test, n.currency, n.subtotal, n.total_discounts, n.total_tax, n.total_shipping,
              n.total_price, n.total_refunded, n.shopify_updated_at)
    )
    insert into public.summary_dirty_months (shop_key, month)
    select shop_key, date_trunc('month', old_at)::date from changed
    union
    select shop_key, date_trunc('month', new_at)::date from changed
    on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger orders_mark_summary_insert after insert on public.orders
  referencing new table as new_rows for each statement execute function public.mark_order_summary_months();
create trigger orders_mark_summary_update after update on public.orders
  referencing old table as old_rows new table as new_rows for each statement execute function public.mark_order_summary_months();
create trigger orders_mark_summary_delete after delete on public.orders
  referencing old table as old_rows for each statement execute function public.mark_order_summary_months();

-- A return line marks the month of the order it returns from.
create or replace function public.mark_return_summary_months()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into public.summary_dirty_months (shop_key, month)
    select distinct o.shop_key, date_trunc('month', o.processed_at)::date
      from new_rows r
      join public.order_line_items li on li.shop_key = r.shop_key and li.shopify_id = r.line_item_shopify_id
      join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
    on conflict do nothing;
  elsif tg_op = 'DELETE' then
    insert into public.summary_dirty_months (shop_key, month)
    select distinct o.shop_key, date_trunc('month', o.processed_at)::date
      from old_rows r
      join public.order_line_items li on li.shop_key = r.shop_key and li.shopify_id = r.line_item_shopify_id
      join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
    on conflict do nothing;
  else
    insert into public.summary_dirty_months (shop_key, month)
    select distinct o.shop_key, date_trunc('month', o.processed_at)::date
      from (select shop_key, line_item_shopify_id from new_rows union select shop_key, line_item_shopify_id from old_rows) r
      join public.order_line_items li on li.shop_key = r.shop_key and li.shopify_id = r.line_item_shopify_id
      join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
    on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger return_line_items_mark_summary_insert after insert on public.return_line_items
  referencing new table as new_rows for each statement execute function public.mark_return_summary_months();
create trigger return_line_items_mark_summary_update after update on public.return_line_items
  referencing old table as old_rows new table as new_rows for each statement execute function public.mark_return_summary_months();
create trigger return_line_items_mark_summary_delete after delete on public.return_line_items
  referencing old table as old_rows for each statement execute function public.mark_return_summary_months();

-- One month of product summaries from detail (0030's calculation), test and cancelled orders excluded.
create or replace function public.detail_product_month(p_shop_key integer, p_month date)
returns table (product_shopify_id bigint, currency text, orders integer, units integer, gross_sales numeric, discounts numeric,
               refunded_units integer, returned_units integer, customers integer, first_time_customers integer)
language sql stable set search_path = public, pg_temp as $$
  select li.product_shopify_id, max(o.currency), count(distinct o.shopify_id)::integer, sum(li.quantity)::integer,
         sum(li.unit_price * li.quantity), sum(li.total_discount), sum(li.refunded_quantity)::integer, coalesce(sum(r.returned), 0)::integer,
         count(distinct o.customer_shopify_id)::integer,
         (count(distinct o.customer_shopify_id) filter (where o.shopify_id = c.first_order_shopify_id))::integer
    from public.order_line_items li
    join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
    left join (select line_item_shopify_id, sum(quantity) as returned from public.return_line_items
                where shop_key = p_shop_key group by 1) r on r.line_item_shopify_id = li.shopify_id
    left join public.customers c on c.shop_key = o.shop_key and c.shopify_id = o.customer_shopify_id
   where li.shop_key = p_shop_key and li.product_shopify_id is not null and not o.is_test and o.cancelled_at is null
     and o.processed_at >= p_month and o.processed_at < p_month + interval '1 month'
   group by li.product_shopify_id;
$$;

-- One month of store summaries from detail (0030's calculation); no row for a month without orders.
create or replace function public.detail_store_month(p_shop_key integer, p_month date)
returns table (currency text, orders integer, units integer, subtotal numeric, total_discounts numeric, total_tax numeric,
               total_shipping numeric, total_price numeric, total_refunded numeric, customers integer, new_customers integer)
language sql stable set search_path = public, pg_temp as $$
  select max(o.currency), count(*)::integer, coalesce(sum(u.units), 0)::integer, sum(o.subtotal), sum(o.total_discounts), sum(o.total_tax),
         sum(o.total_shipping), sum(o.total_price), sum(o.total_refunded), count(distinct o.customer_shopify_id)::integer,
         (count(distinct o.customer_shopify_id) filter (where o.shopify_id = c.first_order_shopify_id))::integer
    from public.orders o
    left join (select li.order_shopify_id, sum(li.quantity) as units
                 from public.order_line_items li
                 join public.orders lo on lo.shop_key = li.shop_key and lo.shopify_id = li.order_shopify_id
                where li.shop_key = p_shop_key and lo.processed_at >= p_month and lo.processed_at < p_month + interval '1 month'
                group by 1) u on u.order_shopify_id = o.shopify_id
    left join public.customers c on c.shop_key = o.shop_key and c.shopify_id = o.customer_shopify_id
   where o.shop_key = p_shop_key and not o.is_test and o.cancelled_at is null
     and o.processed_at >= p_month and o.processed_at < p_month + interval '1 month'
  having count(*) > 0;
$$;

-- One month of one shop: rebuild if open, finalise if due, record adjustments if final. Internal.
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

-- The application's refresh: one month of one shop per call, for a shop open for ingestion.
create or replace function public.refresh_summary_month(p_shop_key integer, p_month date, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  return public.summarise_detail_month(p_shop_key, p_month, p_calc_version);
end;
$$;

-- 0030's range refresh, now month by month through the same calculation. For operations and tests: a large
-- shop's range can exceed the statement timeout, so the application calls refresh_summary_month instead.
create or replace function public.refresh_monthly_aggregates(p_shop_key integer, p_from date, p_to date, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from date := date_trunc('month', p_from)::date;
  v_to date := date_trunc('month', p_to)::date;
  v_month date;
  v_step jsonb;
  v_products integer := 0;
  v_store integer := 0;
  v_cohorts integer := 0;
  v_dated integer := 0;
begin
  if p_shop_key is null or v_from is null or v_to is null or v_to < v_from or coalesce(p_calc_version, 0) < 1 then
    raise exception 'aggregate_range_invalid';
  end if;
  for v_month in select generate_series(v_from, v_to, interval '1 month')::date loop
    v_step := public.summarise_detail_month(p_shop_key, v_month, p_calc_version);
    v_products := v_products + (v_step->>'product_months')::integer;
    v_store := v_store + (v_step->>'store_months')::integer;
    v_cohorts := v_cohorts + (v_step->>'cohort_months')::integer;
    v_dated := v_dated + (v_step->>'products_dated')::integer;
  end loop;
  return jsonb_build_object('product_months', v_products, 'store_months', v_store, 'cohort_months', v_cohorts, 'products_dated', v_dated);
end;
$$;

-- A shop whose summaries the maintenance task may refresh: open for ingestion, orders fully imported once,
-- and no import in progress (an incomplete import's missing orders are never read as corrections). Internal.
create or replace function public.summary_maintenance_ready(p_shop_key integer)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.shop_ingestion_open(s.shop_key)
         and not exists (select 1 from public.shop_imports i where i.shop_id = s.id and i.status in ('requested', 'dispatched', 'running'))
         and exists (select 1 from public.shop_imports i where i.shop_id = s.id and i.status in ('succeeded', 'partial')
                      and i.coverage #>> '{domains,orders,status}' = 'succeeded')
    from public.shops s where s.shop_key = p_shop_key;
$$;

-- The maintenance task's refresh: as refresh_summary_month, after re-checking in the same transaction that the
-- shop is still ready (an import may have started since the month was listed as due).
create or replace function public.maintain_summary_month(p_shop_key integer, p_month date, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if not coalesce(public.summary_maintenance_ready(p_shop_key), false) then
    return jsonb_build_object('month', date_trunc('month', p_month)::date, 'state', 'not_ready');
  end if;
  return public.summarise_detail_month(p_shop_key, p_month, p_calc_version);
end;
$$;

-- What the maintenance task refreshes: changed months first, then every month that can still change (its
-- summary for 120 days, its cohort for 485), for shops ready for maintenance.
create or replace function public.summary_months_due(p_limit integer default 1000)
returns table (shop_key integer, shop_domain text, month date, reason text)
language sql stable security definer set search_path = public, pg_temp as $$
  with ready as (
    select s.shop_key, s.myshopify_domain from public.shops s where public.summary_maintenance_ready(s.shop_key)
  ), due as (
    select d.shop_key, d.month, 'changed'::text as reason from public.summary_dirty_months d
    union all
    select r.shop_key, m::date, 'open'
      from ready r, generate_series(date_trunc('month', now() - interval '485 days'), date_trunc('month', now()), interval '1 month') m
     where exists (select 1 from public.orders o where o.shop_key = r.shop_key)
  )
  select x.shop_key, x.myshopify_domain, x.month, x.reason
    from (select distinct on (d.shop_key, d.month) d.shop_key, r.myshopify_domain, d.month, d.reason
            from due d join ready r on r.shop_key = d.shop_key
           order by d.shop_key, d.month, d.reason) x
   order by x.reason, x.shop_key, x.month
   limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
$$;

-- Effective monthly summaries: each final summary plus its adjustments (customer counts as finalised).
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
  )
  select m.month, m.currency, (m.orders + coalesce(a.orders, 0))::integer, (m.units + coalesce(a.units, 0))::integer,
         m.subtotal + coalesce(a.subtotal, 0), m.total_discounts + coalesce(a.total_discounts, 0), m.total_tax + coalesce(a.total_tax, 0),
         m.total_shipping + coalesce(a.total_shipping, 0), m.total_price + coalesce(a.total_price, 0),
         m.total_refunded + coalesce(a.total_refunded, 0), m.customers, m.new_customers, m.finalized_at is not null, coalesce(a.n, 0)::integer
    from public.store_monthly_metrics m
    left join adjusted a on a.month = m.month
   where m.shop_key = p_shop_key and m.calc_version = p_calc_version and m.month between date_trunc('month', p_from)::date and p_to
   order by m.month;
$$;

-- The deletion helpers (0030), extended to the adjustments and changed months.
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

alter table public.product_monthly_adjustments enable row level security;
alter table public.store_monthly_adjustments enable row level security;
alter table public.summary_dirty_months enable row level security;
revoke all on table public.product_monthly_adjustments, public.store_monthly_adjustments, public.summary_dirty_months
  from public, anon, authenticated, service_role;
grant select on table public.product_monthly_adjustments, public.store_monthly_adjustments, public.summary_dirty_months to service_role;

revoke all on function public.refuse_summary_update(), public.mark_order_summary_months(), public.mark_return_summary_months(),
  public.detail_product_month(integer, date), public.detail_store_month(integer, date), public.summarise_detail_month(integer, date, integer),
  public.summary_maintenance_ready(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.refresh_summary_month(integer, date, integer), public.maintain_summary_month(integer, date, integer), public.summary_months_due(integer),
  public.product_months_effective(integer, date, date, integer), public.store_months_effective(integer, date, date, integer)
  from public, anon, authenticated;
grant execute on function public.refresh_summary_month(integer, date, integer), public.maintain_summary_month(integer, date, integer), public.summary_months_due(integer),
  public.product_months_effective(integer, date, date, integer), public.store_months_effective(integer, date, date, integer)
  to service_role;
