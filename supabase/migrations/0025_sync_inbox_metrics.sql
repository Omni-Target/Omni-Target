-- 0025: sync runs and checkpoints, webhook inbox, metrics (Phase 1, task 8).
--
-- Keyed by shop like the commerce mirror (0024) and deleted with it on
-- shop/redact. Empty until Phase 2. Additive: no existing row changes.

-- One run per import or reconciliation of one data domain. At most one initial
-- or full import per shop and domain is queued or running at a time.
create table public.sync_runs (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops (id),
  domain             text not null check (domain in ('catalog', 'orders', 'customers', 'inventory', 'returns', 'custom_data', 'settings')),
  kind               text not null check (kind in ('initial', 'full', 'incremental', 'reconcile')),
  status             text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  trigger_run_id     text check (char_length(trigger_run_id) <= 128),
  bulk_operation_id  bigint check (bulk_operation_id > 0),
  rows_written       bigint not null default 0 check (rows_written >= 0),
  counts             jsonb not null default '{}' check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 4096),
  coverage           jsonb not null default '{}' check (jsonb_typeof(coverage) = 'object' and pg_column_size(coverage) <= 4096),
  error              text check (char_length(error) <= 2000),
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  check ((status in ('succeeded', 'partial', 'failed', 'cancelled')) = (finished_at is not null)),
  check (status not in ('running', 'succeeded', 'partial') or started_at is not null)
);
create unique index sync_runs_one_full_idx on public.sync_runs (shop_id, domain)
  where kind in ('initial', 'full') and status in ('queued', 'running');
create index sync_runs_shop_idx on public.sync_runs (shop_id, domain, created_at desc);

-- Where an import resumes. Shopify's signed result URL is never stored: it is
-- read again from the bulk operation, and an expired one means re-running it.
create table public.sync_checkpoints (
  shop_id                uuid not null references public.shops (id),
  domain                 text not null check (domain in ('catalog', 'orders', 'customers', 'inventory', 'returns', 'custom_data', 'settings')),
  sync_run_id            uuid references public.sync_runs (id) on delete set null,
  bulk_operation_id      bigint check (bulk_operation_id > 0),
  result_url_expires_at  timestamptz,
  committed_line         bigint not null default 0 check (committed_line >= 0),
  watermark              timestamptz,
  updated_at             timestamptz not null default now(),
  primary key (shop_id, domain)
);

-- Webhook inbox: one row per delivery, recorded before Shopify gets its 200.
-- The payload is kept only until the delivery is handled; a dead delivery
-- keeps it for replay. Rows are removed after 30 days.
create table public.webhook_events (
  id            uuid primary key default gen_random_uuid(),
  shop_domain   text not null check (public.myshopify_domain_or_null(shop_domain) is not distinct from shop_domain),
  shop_id       uuid references public.shops (id),
  webhook_id    text not null check (char_length(webhook_id) between 1 and 255),
  event_id      text check (char_length(event_id) <= 255),
  topic         text not null check (topic ~ '^[a-z_]{1,64}/[a-z_]{1,64}$'),
  triggered_at  timestamptz,
  received_at   timestamptz not null default now(),
  payload       jsonb check (pg_column_size(payload) <= 524288),
  status        text not null default 'received' check (status in ('received', 'processing', 'processed', 'failed', 'dead', 'ignored')),
  attempts      integer not null default 0 check (attempts >= 0),
  last_error    text check (char_length(last_error) <= 2000),
  processed_at  timestamptz,
  unique (shop_domain, webhook_id),
  check ((status in ('processed', 'ignored')) = (processed_at is not null)),
  check (status not in ('processed', 'ignored') or payload is null)
);
create index webhook_events_pending_idx on public.webhook_events (received_at) where status in ('received', 'failed');
create index webhook_events_received_idx on public.webhook_events (received_at);

-- Derived metrics, one row per window and calculation version, recomputed in
-- place. A metric whose input Shopify withheld is listed in `unavailable` with
-- its reason, never reported as zero. Monthly aggregates that outlive order
-- retention are designed with the retention evaluation (task 11).
create table public.product_metrics (
  shop_id               uuid not null references public.shops (id),
  product_shopify_id    bigint not null check (product_shopify_id > 0),
  window_days           integer not null check (window_days in (7, 14, 30, 60, 90, 180, 365)),
  calc_version          integer not null check (calc_version > 0),
  window_end            timestamptz not null,
  currency              text not null check (currency ~ '^[A-Z]{3}$'),
  orders                integer not null default 0 check (orders >= 0),
  units                 integer not null default 0 check (units >= 0),
  gross_sales           numeric(20, 4) not null default 0 check (gross_sales >= 0),
  discounts             numeric(20, 4) not null default 0 check (discounts >= 0),
  net_sales             numeric(20, 4) not null default 0,
  refunded_units        integer not null default 0 check (refunded_units >= 0),
  refunded_amount       numeric(20, 4) not null default 0 check (refunded_amount >= 0),
  returned_units        integer not null default 0 check (returned_units >= 0),
  customers             integer not null default 0 check (customers >= 0),
  first_time_customers  integer not null default 0 check (first_time_customers >= 0),
  unavailable           jsonb not null default '{}' check (jsonb_typeof(unavailable) = 'object' and pg_column_size(unavailable) <= 4096),
  computed_at           timestamptz not null default now(),
  primary key (shop_id, product_shopify_id, window_days, calc_version)
);

create table public.store_metrics (
  shop_id              uuid not null references public.shops (id),
  window_days          integer not null check (window_days in (7, 14, 30, 60, 90, 180, 365)),
  calc_version         integer not null check (calc_version > 0),
  window_end           timestamptz not null,
  currency             text not null check (currency ~ '^[A-Z]{3}$'),
  orders               integer not null default 0 check (orders >= 0),
  units                integer not null default 0 check (units >= 0),
  gross_sales          numeric(20, 4) not null default 0 check (gross_sales >= 0),
  discounts            numeric(20, 4) not null default 0 check (discounts >= 0),
  net_sales            numeric(20, 4) not null default 0,
  refunded_amount      numeric(20, 4) not null default 0 check (refunded_amount >= 0),
  customers            integer not null default 0 check (customers >= 0),
  new_customers        integer not null default 0 check (new_customers >= 0),
  returning_customers  integer not null default 0 check (returning_customers >= 0),
  unavailable          jsonb not null default '{}' check (jsonb_typeof(unavailable) = 'object' and pg_column_size(unavailable) <= 4096),
  computed_at          timestamptz not null default now(),
  primary key (shop_id, window_days, calc_version)
);

-- 0024's helpers, extended to these tables. Inbox rows are matched by domain
-- too, because a delivery can arrive for a shop not yet modelled.
create or replace function public.delete_shop_synced_data(p_domain text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_domain text := public.normalize_shop_host(p_domain);
  v_shop uuid;
begin
  if v_domain is null then return; end if;
  select id into v_shop from public.shops where myshopify_domain = v_domain;
  delete from public.webhook_events where shop_domain = v_domain or (v_shop is not null and shop_id = v_shop);
  if v_shop is null then return; end if;
  delete from public.product_metrics where shop_id = v_shop;
  delete from public.store_metrics where shop_id = v_shop;
  delete from public.sync_checkpoints where shop_id = v_shop;
  delete from public.sync_runs where shop_id = v_shop;
  delete from public.return_line_items where shop_id = v_shop;
  delete from public.returns where shop_id = v_shop;
  delete from public.refunds where shop_id = v_shop;
  delete from public.order_line_items where shop_id = v_shop;
  delete from public.orders where shop_id = v_shop;
  delete from public.customers where shop_id = v_shop;
  delete from public.inventory_levels where shop_id = v_shop;
  delete from public.inventory_locations where shop_id = v_shop;
  delete from public.product_variants where shop_id = v_shop;
  delete from public.products where shop_id = v_shop;
  delete from public.metafields where shop_id = v_shop;
  delete from public.metaobjects where shop_id = v_shop;
  delete from public.metaobject_definitions where shop_id = v_shop;
  delete from public.shop_settings where shop_id = v_shop;
  delete from public.shop_access where shop_id = v_shop;
end;
$$;

create or replace function public.shop_synced_row_count(p_domain text)
returns bigint language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_domain text := public.normalize_shop_host(p_domain);
  v_shop uuid;
  v_inbox bigint;
begin
  if v_domain is null then return 0; end if;
  select id into v_shop from public.shops where myshopify_domain = v_domain;
  select count(*) into v_inbox from public.webhook_events where shop_domain = v_domain or (v_shop is not null and shop_id = v_shop);
  if v_shop is null then return v_inbox; end if;
  return v_inbox
       + (select count(*) from public.product_metrics where shop_id = v_shop)
       + (select count(*) from public.store_metrics where shop_id = v_shop)
       + (select count(*) from public.sync_checkpoints where shop_id = v_shop)
       + (select count(*) from public.sync_runs where shop_id = v_shop)
       + (select count(*) from public.products where shop_id = v_shop)
       + (select count(*) from public.product_variants where shop_id = v_shop)
       + (select count(*) from public.inventory_locations where shop_id = v_shop)
       + (select count(*) from public.inventory_levels where shop_id = v_shop)
       + (select count(*) from public.customers where shop_id = v_shop)
       + (select count(*) from public.orders where shop_id = v_shop)
       + (select count(*) from public.order_line_items where shop_id = v_shop)
       + (select count(*) from public.refunds where shop_id = v_shop)
       + (select count(*) from public.returns where shop_id = v_shop)
       + (select count(*) from public.return_line_items where shop_id = v_shop)
       + (select count(*) from public.metafields where shop_id = v_shop)
       + (select count(*) from public.metaobject_definitions where shop_id = v_shop)
       + (select count(*) from public.metaobjects where shop_id = v_shop)
       + (select count(*) from public.shop_settings where shop_id = v_shop)
       + (select count(*) from public.shop_access where shop_id = v_shop);
end;
$$;

alter table public.sync_runs enable row level security;
alter table public.sync_checkpoints enable row level security;
alter table public.webhook_events enable row level security;
alter table public.product_metrics enable row level security;
alter table public.store_metrics enable row level security;

revoke all on table public.sync_runs, public.sync_checkpoints, public.webhook_events, public.product_metrics, public.store_metrics
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.sync_runs, public.sync_checkpoints, public.webhook_events,
  public.product_metrics, public.store_metrics to service_role;

revoke all on function public.delete_shop_synced_data(text), public.shop_synced_row_count(text)
  from public, anon, authenticated, service_role;
