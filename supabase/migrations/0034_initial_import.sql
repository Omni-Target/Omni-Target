-- 0034: the initial import workflow (Phase 2, task 6).
--
--  - shop_imports: one durable record per import, created before anything is
--    dispatched to Trigger.dev, so a failed dispatch is found and retried by
--    the reconcile job. At most one active import per shop. A run claims the
--    import before working: a finished import is never run again, a live run
--    is not doubled, and a run whose heartbeat went stale can be taken over.
--  - History beyond the retained window (decision 3): orders older than the
--    window are staged in unlogged tables for the length of one import,
--    summarised month by month into final product and store summaries, and
--    discarded. Staged customers are keyed digests only, never Shopify IDs,
--    and suppressed customers and orders are staged without one.
--  - The retained window now starts at the beginning of the month 24 months
--    ago, so every history month is whole and summarised from one source;
--    ingest_orders is redefined with that cutoff and is otherwise unchanged.
--
-- Changes no existing rows.

create table public.shop_imports (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops (id),
  kind               text not null default 'initial' check (kind in ('initial')),
  status             text not null default 'requested'
                     check (status in ('requested', 'dispatched', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  trigger_run_id     text check (char_length(trigger_run_id) <= 128),
  dispatch_attempts  integer not null default 0 check (dispatch_attempts >= 0),
  requested_at       timestamptz not null default now(),
  dispatched_at      timestamptz,
  started_at         timestamptz,
  heartbeat_at       timestamptz,
  finished_at        timestamptz,
  coverage           jsonb not null default '{}' check (jsonb_typeof(coverage) = 'object' and pg_column_size(coverage) <= 16384),
  error              text check (char_length(error) <= 2000),
  check ((status in ('succeeded', 'partial', 'failed', 'cancelled')) = (finished_at is not null))
);
create unique index shop_imports_one_active_idx on public.shop_imports (shop_id) where status in ('requested', 'dispatched', 'running');
create index shop_imports_active_idx on public.shop_imports (status) where status in ('requested', 'dispatched', 'running');

create unlogged table public.history_stage_orders (
  import_id         uuid not null references public.shop_imports (id) on delete cascade,
  order_shopify_id  bigint not null check (order_shopify_id > 0),
  processed_at      timestamptz not null,
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal          numeric(20, 4) not null default 0,
  total_discounts   numeric(20, 4) not null default 0,
  total_tax         numeric(20, 4) not null default 0,
  total_shipping    numeric(20, 4) not null default 0,
  total_price       numeric(20, 4) not null default 0,
  total_refunded    numeric(20, 4) not null default 0,
  customer_digest   bytea check (octet_length(customer_digest) = 32),
  is_test           boolean not null default false,
  cancelled         boolean not null default false,
  primary key (import_id, order_shopify_id)
);
create index history_stage_orders_month_idx on public.history_stage_orders (import_id, processed_at);
create index history_stage_orders_customer_idx on public.history_stage_orders (import_id, customer_digest, processed_at) where customer_digest is not null;

create unlogged table public.history_stage_lines (
  import_id           uuid not null references public.shop_imports (id) on delete cascade,
  line_shopify_id     bigint not null check (line_shopify_id > 0),
  order_shopify_id    bigint not null,
  product_shopify_id  bigint,
  quantity            integer not null default 0 check (quantity >= 0),
  gross               numeric(20, 4) not null default 0,
  discount            numeric(20, 4) not null default 0,
  refunded            integer not null default 0 check (refunded >= 0),
  primary key (import_id, line_shopify_id)
);
create index history_stage_lines_order_idx on public.history_stage_lines (import_id, order_shopify_id);

-- Start of the retained window: the first day of the month 24 months ago.
create or replace function public.retention_window_start()
returns timestamptz language sql stable set search_path = public, pg_temp as $$
  select date_trunc('month', now() - interval '24 months');
$$;

create or replace function public.request_shop_import(p_shop_key integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop uuid;
  v_row public.shop_imports;
begin
  select id into v_shop from public.shops where shop_key = p_shop_key;
  if v_shop is null then raise exception 'shop_not_found'; end if;
  if not public.shop_ingestion_open(p_shop_key) then return jsonb_build_object('outcome', 'not_ingestible'); end if;
  select * into v_row from public.shop_imports where shop_id = v_shop and status in ('requested', 'dispatched', 'running');
  if found then
    return jsonb_build_object('outcome', 'existing', 'import_id', v_row.id, 'status', v_row.status, 'dispatch_attempts', v_row.dispatch_attempts);
  end if;
  begin
    insert into public.shop_imports (shop_id) values (v_shop) returning * into v_row;
  exception when unique_violation then
    select * into v_row from public.shop_imports where shop_id = v_shop and status in ('requested', 'dispatched', 'running');
    return jsonb_build_object('outcome', 'existing', 'import_id', v_row.id, 'status', v_row.status, 'dispatch_attempts', v_row.dispatch_attempts);
  end;
  return jsonb_build_object('outcome', 'requested', 'import_id', v_row.id, 'status', v_row.status, 'dispatch_attempts', 0);
end;
$$;

create or replace function public.mark_import_dispatched(p_import uuid, p_run_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.shop_imports
     set status = case when status = 'requested' then 'dispatched' else status end,
         trigger_run_id = coalesce(trigger_run_id, p_run_id), dispatch_attempts = dispatch_attempts + 1, dispatched_at = now()
   where id = p_import and status in ('requested', 'dispatched', 'running');
  return jsonb_build_object('outcome', case when found then 'dispatched' else 'finished' end);
end;
$$;

-- A run claims the import before working. Finished: nothing to do. Running
-- under another live run: busy. Otherwise this run takes it.
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

create or replace function public.import_heartbeat(p_import uuid, p_run_id text, p_coverage jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.shop_imports set heartbeat_at = now(), coverage = coalesce(p_coverage, coverage)
   where id = p_import and status = 'running' and trigger_run_id = p_run_id;
  return jsonb_build_object('outcome', case when found then 'ok' else 'lost' end);
end;
$$;

-- Ends an import. p_run_id null is the reconcile job closing one it gave up on.
create or replace function public.finish_shop_import(p_import uuid, p_run_id text, p_status text, p_coverage jsonb default null, p_error text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('succeeded', 'partial', 'failed', 'cancelled') then raise exception 'import_status_invalid'; end if;
  update public.shop_imports
     set status = p_status, finished_at = now(), coverage = coalesce(p_coverage, coverage), error = left(p_error, 2000), heartbeat_at = now()
   where id = p_import and status in ('requested', 'dispatched', 'running')
     and (p_run_id is null or trigger_run_id is null or trigger_run_id = p_run_id);
  return jsonb_build_object('outcome', case when found then 'finished' else 'not_active' end);
end;
$$;

-- Imports the reconcile job must (re)dispatch: requested but never
-- dispatched, or dispatched or running with no sign of life.
create or replace function public.imports_needing_dispatch(p_requested_grace_seconds integer, p_stale_seconds integer, p_limit integer default 50)
returns table (import_id uuid, shop_domain text, status text, dispatch_attempts integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, s.myshopify_domain, i.status, i.dispatch_attempts
    from public.shop_imports i join public.shops s on s.id = i.shop_id
   where (i.status = 'requested' and i.requested_at < now() - make_interval(secs => p_requested_grace_seconds))
      or (i.status in ('dispatched', 'running') and coalesce(i.heartbeat_at, i.dispatched_at, i.requested_at) < now() - make_interval(secs => p_stale_seconds))
   order by i.requested_at
   limit least(greatest(p_limit, 1), 200);
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

-- One whole history month into final product and store summaries. A
-- customer's first order is their earliest staged order (history precedes
-- the retained window). Test and cancelled orders are left out.
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

-- The staged history of an import, in bounded deletes; call until nothing remains.
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

-- History months of an import (whole months before the retained window).
create or replace function public.history_stage_months(p_import uuid)
returns table (month date, orders bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select date_trunc('month', processed_at)::date, count(*) from public.history_stage_orders where import_id = p_import group by 1 order by 1;
$$;

-- ingest_orders (0032) with the month-aligned window start; nothing else differs.
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

alter table public.shop_imports enable row level security;
alter table public.history_stage_orders enable row level security;
alter table public.history_stage_lines enable row level security;
revoke all on table public.shop_imports, public.history_stage_orders, public.history_stage_lines from public, anon, authenticated, service_role;
grant select on table public.shop_imports to service_role;

revoke all on function public.retention_window_start(), public.request_shop_import(integer), public.mark_import_dispatched(uuid, text),
  public.claim_shop_import(uuid, text, integer), public.import_heartbeat(uuid, text, jsonb), public.finish_shop_import(uuid, text, text, jsonb, text),
  public.imports_needing_dispatch(integer, integer, integer), public.stage_history_orders(uuid, jsonb, jsonb),
  public.summarise_history_month(uuid, date, integer), public.discard_history_stage(uuid, integer), public.history_stage_months(uuid)
  from public, anon, authenticated;
grant execute on function public.retention_window_start(), public.request_shop_import(integer), public.mark_import_dispatched(uuid, text),
  public.claim_shop_import(uuid, text, integer), public.import_heartbeat(uuid, text, jsonb), public.finish_shop_import(uuid, text, text, jsonb, text),
  public.imports_needing_dispatch(integer, integer, integer), public.stage_history_orders(uuid, jsonb, jsonb),
  public.summarise_history_month(uuid, date, integer), public.discard_history_stage(uuid, integer), public.history_stage_months(uuid)
  to service_role;
