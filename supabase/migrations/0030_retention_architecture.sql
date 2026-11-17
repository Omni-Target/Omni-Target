-- 0030: order retention architecture (Phase 1, task 12; task 11 decisions).
--
-- Approved: 24 months of line-level order history, kept analysable beyond
-- that by permanent monthly summaries. This migration builds the structures
-- only. It deletes nothing and contains no pruning: pruning needs separate,
-- explicit approval and verified backup and restore.
--
--  - product_monthly_metrics and store_monthly_metrics: permanent monthly
--    summaries for year-over-year and historical product performance.
--  - cohort_monthly_outcomes: anonymised cohort statistics (counts and
--    revenue by first-order month, no customer identifiers), the permanent
--    record of repeat behaviour.
--  - products.first_sold_at and last_sold_at: product facts with no personal
--    information, kept permanently.
--  - Customer rows are not permanent: they serve first-order and repeat
--    analysis inside the retention window only (customers.last_order_at says
--    when a customer leaves it), and customers/redact now removes them.
--  - refresh_monthly_aggregates rebuilds summaries from retained order lines
--    and finalises a month 120 days after it ends; retention_status reports
--    what retention would cover, read-only.

alter table public.products
  add column first_sold_at timestamptz,
  add column last_sold_at timestamptz,
  add constraint products_sale_dates check (first_sold_at is null or last_sold_at is null or first_sold_at <= last_sold_at);

alter table public.customers add column last_order_at timestamptz;
comment on table public.customers is
  'Minimal customer facts (no name, email, phone or address), kept only while the customer has orders inside the 24-month retention window, for first-order and repeat analysis. Removed on customers/redact and shop/redact. Permanent history is the anonymised cohort_monthly_outcomes.';

create table public.product_monthly_metrics (
  shop_key              integer not null references public.shops (shop_key),
  product_shopify_id    bigint not null check (product_shopify_id > 0),
  month                 date not null check (month = date_trunc('month', month)::date),
  calc_version          integer not null check (calc_version > 0),
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  orders                integer not null default 0 check (orders >= 0),
  units                 integer not null default 0 check (units >= 0),
  gross_sales           numeric(20, 4) not null default 0 check (gross_sales >= 0),
  discounts             numeric(20, 4) not null default 0 check (discounts >= 0),
  refunded_units        integer not null default 0 check (refunded_units >= 0),
  returned_units        integer not null default 0 check (returned_units >= 0),
  customers             integer not null default 0 check (customers >= 0),
  first_time_customers  integer not null default 0 check (first_time_customers >= 0 and first_time_customers <= customers),
  computed_at           timestamptz not null default now(),
  finalized_at          timestamptz,
  primary key (shop_key, product_shopify_id, month, calc_version),
  check (orders > 0 or units > 0 or refunded_units > 0 or returned_units > 0)
);
create index product_monthly_metrics_month_idx on public.product_monthly_metrics (shop_key, month, calc_version);

create table public.store_monthly_metrics (
  shop_key             integer not null references public.shops (shop_key),
  month                date not null check (month = date_trunc('month', month)::date),
  calc_version         integer not null check (calc_version > 0),
  currency             text not null check (currency ~ '^[A-Z]{3}$'),
  orders               integer not null default 0 check (orders >= 0),
  units                integer not null default 0 check (units >= 0),
  subtotal             numeric(20, 4) not null default 0 check (subtotal >= 0),
  total_discounts      numeric(20, 4) not null default 0 check (total_discounts >= 0),
  total_tax            numeric(20, 4) not null default 0 check (total_tax >= 0),
  total_shipping       numeric(20, 4) not null default 0 check (total_shipping >= 0),
  total_price          numeric(20, 4) not null default 0 check (total_price >= 0),
  total_refunded       numeric(20, 4) not null default 0 check (total_refunded >= 0),
  customers            integer not null default 0 check (customers >= 0),
  new_customers        integer not null default 0 check (new_customers >= 0 and new_customers <= customers),
  computed_at          timestamptz not null default now(),
  finalized_at         timestamptz,
  primary key (shop_key, month, calc_version)
);

-- Counts and revenue only: no customer identifiers, so redaction never needs to touch them.
create table public.cohort_monthly_outcomes (
  shop_key              integer not null references public.shops (shop_key),
  cohort_month          date not null check (cohort_month = date_trunc('month', cohort_month)::date),
  calc_version          integer not null check (calc_version > 0),
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  first_time_customers  integer not null check (first_time_customers > 0),
  repeat_30d            integer not null default 0 check (repeat_30d >= 0),
  repeat_60d            integer not null default 0,
  repeat_90d            integer not null default 0,
  repeat_180d           integer not null default 0,
  repeat_365d           integer not null default 0,
  first_order_revenue   numeric(20, 4) not null default 0 check (first_order_revenue >= 0),
  revenue_60d           numeric(20, 4) not null default 0 check (revenue_60d >= 0),
  observed_through      timestamptz not null,
  computed_at           timestamptz not null default now(),
  finalized_at          timestamptz,
  primary key (shop_key, cohort_month, calc_version),
  check (repeat_30d <= repeat_60d and repeat_60d <= repeat_90d and repeat_90d <= repeat_180d
         and repeat_180d <= repeat_365d and repeat_365d <= first_time_customers)
);

-- Rebuilds one shop's summaries for a range of months from the retained order
-- lines (test and cancelled orders excluded), and its products' sale dates.
-- A finalised month is never changed: product and store months finalise 120
-- days after they end (time for late refunds and returns); a cohort finalises
-- once its 365-day window has closed, plus the same 120 days.
create or replace function public.refresh_monthly_aggregates(p_shop_key integer, p_from date, p_to date, p_calc_version integer default 1)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from date := date_trunc('month', p_from)::date;
  v_to date := date_trunc('month', p_to)::date;
  v_final_before date := date_trunc('month', now() - interval '120 days')::date;
  v_cohort_final_before date := date_trunc('month', now() - interval '485 days')::date;
  v_products integer;
  v_store integer;
  v_cohorts integer;
  v_sale_dates integer;
begin
  if p_shop_key is null or v_from is null or v_to is null or v_to < v_from or coalesce(p_calc_version, 0) < 1 then
    raise exception 'aggregate_range_invalid';
  end if;

  delete from public.product_monthly_metrics
   where shop_key = p_shop_key and calc_version = p_calc_version and month between v_from and v_to and finalized_at is null;
  insert into public.product_monthly_metrics (shop_key, product_shopify_id, month, calc_version, currency, orders, units, gross_sales,
    discounts, refunded_units, returned_units, customers, first_time_customers, finalized_at)
  select p_shop_key, li.product_shopify_id, date_trunc('month', o.processed_at)::date, p_calc_version, max(o.currency),
         count(distinct o.shopify_id), sum(li.quantity), sum(li.unit_price * li.quantity), sum(li.total_discount),
         sum(li.refunded_quantity), coalesce(sum(r.returned), 0), count(distinct o.customer_shopify_id),
         count(distinct o.customer_shopify_id) filter (where o.shopify_id = c.first_order_shopify_id),
         case when date_trunc('month', o.processed_at)::date < v_final_before then now() end
    from public.order_line_items li
    join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
    left join (select line_item_shopify_id, sum(quantity) as returned from public.return_line_items
                where shop_key = p_shop_key group by 1) r on r.line_item_shopify_id = li.shopify_id
    left join public.customers c on c.shop_key = o.shop_key and c.shopify_id = o.customer_shopify_id
   where li.shop_key = p_shop_key and li.product_shopify_id is not null and not o.is_test and o.cancelled_at is null
     and o.processed_at >= v_from and o.processed_at < v_to + interval '1 month'
   group by li.product_shopify_id, date_trunc('month', o.processed_at)::date
  on conflict (shop_key, product_shopify_id, month, calc_version) do nothing;
  get diagnostics v_products = row_count;

  delete from public.store_monthly_metrics
   where shop_key = p_shop_key and calc_version = p_calc_version and month between v_from and v_to and finalized_at is null;
  insert into public.store_monthly_metrics (shop_key, month, calc_version, currency, orders, units, subtotal, total_discounts,
    total_tax, total_shipping, total_price, total_refunded, customers, new_customers, finalized_at)
  select p_shop_key, date_trunc('month', o.processed_at)::date, p_calc_version, max(o.currency), count(*), coalesce(sum(u.units), 0),
         sum(o.subtotal), sum(o.total_discounts), sum(o.total_tax), sum(o.total_shipping), sum(o.total_price), sum(o.total_refunded),
         count(distinct o.customer_shopify_id), count(distinct o.customer_shopify_id) filter (where o.shopify_id = c.first_order_shopify_id),
         case when date_trunc('month', o.processed_at)::date < v_final_before then now() end
    from public.orders o
    left join (select li.order_shopify_id, sum(li.quantity) as units
                 from public.order_line_items li
                 join public.orders lo on lo.shop_key = li.shop_key and lo.shopify_id = li.order_shopify_id
                where li.shop_key = p_shop_key and lo.processed_at >= v_from and lo.processed_at < v_to + interval '1 month'
                group by 1) u on u.order_shopify_id = o.shopify_id
    left join public.customers c on c.shop_key = o.shop_key and c.shopify_id = o.customer_shopify_id
   where o.shop_key = p_shop_key and not o.is_test and o.cancelled_at is null
     and o.processed_at >= v_from and o.processed_at < v_to + interval '1 month'
   group by date_trunc('month', o.processed_at)::date
  on conflict (shop_key, month, calc_version) do nothing;
  get diagnostics v_store = row_count;

  delete from public.cohort_monthly_outcomes
   where shop_key = p_shop_key and calc_version = p_calc_version and cohort_month between v_from and v_to and finalized_at is null;
  insert into public.cohort_monthly_outcomes (shop_key, cohort_month, calc_version, currency, first_time_customers, repeat_30d,
    repeat_60d, repeat_90d, repeat_180d, repeat_365d, first_order_revenue, revenue_60d, observed_through, finalized_at)
  select p_shop_key, date_trunc('month', c.first_order_at)::date, p_calc_version, max(f.currency), count(*),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '30 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '60 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '90 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '180 days'),
         count(*) filter (where nx.next_at <= c.first_order_at + interval '365 days'),
         coalesce(sum(f.total_price), 0), coalesce(sum(r60.revenue), 0), now(),
         case when date_trunc('month', c.first_order_at)::date < v_cohort_final_before then now() end
    from public.customers c
    join public.orders f on f.shop_key = c.shop_key and f.shopify_id = c.first_order_shopify_id
    left join lateral (select min(o.processed_at) as next_at from public.orders o
                        where o.shop_key = c.shop_key and o.customer_shopify_id = c.shopify_id and o.processed_at > c.first_order_at
                          and not o.is_test and o.cancelled_at is null) nx on true
    left join lateral (select sum(o.total_price) as revenue from public.orders o
                        where o.shop_key = c.shop_key and o.customer_shopify_id = c.shopify_id
                          and o.processed_at >= c.first_order_at and o.processed_at <= c.first_order_at + interval '60 days'
                          and not o.is_test and o.cancelled_at is null) r60 on true
   where c.shop_key = p_shop_key and c.first_order_at >= v_from and c.first_order_at < v_to + interval '1 month'
   group by date_trunc('month', c.first_order_at)::date
  on conflict (shop_key, cohort_month, calc_version) do nothing;
  get diagnostics v_cohorts = row_count;

  -- Sale dates only ever widen, so they survive the pruning of the orders behind them,
  -- and each refresh need only read its own range of months.
  update public.products p
     set first_sold_at = least(p.first_sold_at, s.first_at), last_sold_at = greatest(p.last_sold_at, s.last_at)
    from (select li.product_shopify_id, min(o.processed_at) as first_at, max(o.processed_at) as last_at
            from public.order_line_items li join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
           where li.shop_key = p_shop_key and li.product_shopify_id is not null and not o.is_test and o.cancelled_at is null
             and o.processed_at >= v_from and o.processed_at < v_to + interval '1 month'
           group by 1) s
   where p.shop_key = p_shop_key and p.shopify_id = s.product_shopify_id
     and (p.first_sold_at is distinct from least(p.first_sold_at, s.first_at) or p.last_sold_at is distinct from greatest(p.last_sold_at, s.last_at));
  get diagnostics v_sale_dates = row_count;

  return jsonb_build_object('product_months', v_products, 'store_months', v_store, 'cohort_months', v_cohorts, 'products_dated', v_sale_dates);
end;
$$;

-- What 24-month retention would cover for one shop. Read-only: pruning is not
-- implemented and needs separate approval and verified backup and restore.
create or replace function public.retention_status(p_shop_key integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with cutoff as (select (now() - interval '24 months') as at)
  select jsonb_build_object(
    'retention_months', 24,
    'cutoff', (select at from cutoff),
    'orders_beyond', (select count(*) from public.orders o, cutoff where o.shop_key = p_shop_key and o.processed_at < cutoff.at),
    'line_items_beyond', (select count(*) from public.order_line_items li join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id, cutoff
                           where li.shop_key = p_shop_key and o.processed_at < cutoff.at),
    'customers_beyond', (select count(*) from public.customers c, cutoff where c.shop_key = p_shop_key and c.last_order_at < cutoff.at),
    'months_beyond', (select count(distinct date_trunc('month', o.processed_at)) from public.orders o, cutoff where o.shop_key = p_shop_key and o.processed_at < cutoff.at),
    'months_beyond_unsummarised', (select count(*) from (select distinct date_trunc('month', o.processed_at)::date as month from public.orders o, cutoff
                                     where o.shop_key = p_shop_key and o.processed_at < cutoff.at) m
                                    where not exists (select 1 from public.store_monthly_metrics s where s.shop_key = p_shop_key and s.month = m.month and s.finalized_at is not null)),
    'pruning', 'not_authorised');
$$;

-- customers/redact removes the customer's data from the commerce mirror;
-- customers/data_request stays open when data is held, for fulfilment.
drop function public.record_customer_compliance(text, bigint, text, text, timestamptz);
create function public.record_customer_compliance(
  p_topic text, p_shopify_shop_id bigint, p_domain text, p_event_key text, p_triggered_at timestamptz,
  p_customer_shopify_id bigint default null, p_order_ids bigint[] default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := lower(btrim(coalesce(p_domain, '')));
  v_orders_named bigint[] := coalesce(p_order_ids, '{}');
  v_event bigint;
  v_request uuid;
  v_key integer;
  v_customers integer := 0;
  v_orders integer := 0;
  v_inbox integer := 0;
  v_held boolean := false;
  v_status text;
  v_resolution text;
begin
  if p_topic not in ('customers/redact', 'customers/data_request') then raise exception 'unsupported_compliance_topic'; end if;
  insert into public.shop_lifecycle_events (topic, event_key, shopify_shop_id, shop_domain, triggered_at)
  values (p_topic, p_event_key, p_shopify_shop_id, v_domain, p_triggered_at)
  on conflict (topic, event_key) do nothing returning id into v_event;
  if v_event is null then return jsonb_build_object('outcome', 'duplicate'); end if;

  select shop_key into v_key from public.shops
   where (p_shopify_shop_id is not null and shopify_shop_id = p_shopify_shop_id) or myshopify_domain = public.myshopify_domain_or_null(v_domain)
   order by (shopify_shop_id = p_shopify_shop_id) desc nulls last limit 1;

  if p_topic = 'customers/redact' then
    if v_key is not null then
      delete from public.customers where shop_key = v_key and shopify_id = p_customer_shopify_id;
      get diagnostics v_customers = row_count;
      update public.orders
         set customer_shopify_id = null, ship_city = null, ship_city_raw = null, ship_province_code = null
       where shop_key = v_key and (customer_shopify_id = p_customer_shopify_id or shopify_id = any(v_orders_named))
         and (customer_shopify_id is not null or ship_city is not null or ship_city_raw is not null or ship_province_code is not null);
      get diagnostics v_orders = row_count;
    end if;
    -- Inbox payloads about the customer, or carrying one of the named orders, are dropped unprocessed.
    update public.webhook_events
       set payload = null, status = 'ignored', processed_at = now(), last_error = 'customer_redacted'
     where shop_domain = v_domain and payload is not null
       and ((p_customer_shopify_id is not null and (payload -> 'customer' ->> 'id' = p_customer_shopify_id::text
                                                    or (topic like 'customers/%' and payload ->> 'id' = p_customer_shopify_id::text)))
            or (topic like 'orders/%' and payload ->> 'id' = any (v_orders_named::text[])));
    get diagnostics v_inbox = row_count;
    v_status := 'completed';
    v_resolution := case when v_customers + v_orders + v_inbox > 0 then 'customer_data_redacted' else 'no_customer_data_held' end;
  else
    v_held := v_key is not null and (
      exists (select 1 from public.customers where shop_key = v_key and shopify_id = p_customer_shopify_id)
      or exists (select 1 from public.orders where shop_key = v_key
                  and (customer_shopify_id = p_customer_shopify_id or (shopify_id = any(v_orders_named) and customer_shopify_id is not null))));
    v_status := case when v_held then 'open' else 'completed' end;
    v_resolution := case when v_held then null else 'no_customer_data_held' end;
  end if;

  update public.shop_lifecycle_events set outcome = coalesce(v_resolution, 'customer_data_held') where id = v_event;
  insert into public.compliance_requests (lifecycle_event_id, topic, shopify_shop_id, shop_domain, received_at, due_at, status, resolution, completed_at)
  values (v_event, p_topic, p_shopify_shop_id, v_domain, now(), now() + interval '30 days', v_status, v_resolution,
          case when v_status = 'completed' then now() end)
  returning id into v_request;
  return jsonb_build_object('outcome', v_status, 'compliance_request_id', v_request, 'resolution', v_resolution,
    'redacted', jsonb_build_object('customers', v_customers, 'orders', v_orders, 'inbox', v_inbox));
end;
$$;

-- The deletion helpers (0029), extended to the summaries.
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

alter table public.product_monthly_metrics enable row level security;
alter table public.store_monthly_metrics enable row level security;
alter table public.cohort_monthly_outcomes enable row level security;
revoke all on table public.product_monthly_metrics, public.store_monthly_metrics, public.cohort_monthly_outcomes
  from public, anon, authenticated, service_role;
grant select on table public.product_monthly_metrics, public.store_monthly_metrics, public.cohort_monthly_outcomes to service_role;

revoke all on function public.refresh_monthly_aggregates(integer, date, date, integer), public.retention_status(integer),
  public.record_customer_compliance(text, bigint, text, text, timestamptz, bigint, bigint[]) from public, anon, authenticated;
grant execute on function public.refresh_monthly_aggregates(integer, date, date, integer), public.retention_status(integer),
  public.record_customer_compliance(text, bigint, text, text, timestamptz, bigint, bigint[]) to service_role;
revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;
