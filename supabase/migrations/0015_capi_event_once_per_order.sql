-- ING-05 (Phase S1): two separate idempotency guarantees for Shopify webhooks.
--
-- 1. Delivery: webhook_deliveries, unique on (shop_domain, webhook_id). A retried
--    delivery of the same webhook does nothing. Distinct webhooks about the same
--    order (orders/updated, refunds/create) have their own ids and still run.
-- 2. Business event: capi_events, unique on (shop_domain, shopify_order_id,
--    event_type). A Meta Purchase is sent at most once per order, even if
--    Shopify fires orders/paid again under a new webhook id.
--
-- The full durable inbox (status, retries, payload) is Phase 2; this table only
-- records that a delivery was accepted.
create table if not exists public.webhook_deliveries (
  shop_domain text not null,
  webhook_id  text not null,
  topic       text not null,
  received_at timestamptz not null default now(),
  primary key (shop_domain, webhook_id)
);
create index if not exists webhook_deliveries_received_at_idx
  on public.webhook_deliveries (received_at);
alter table public.webhook_deliveries enable row level security;
revoke all on table public.webhook_deliveries from public, anon, authenticated;
grant select, insert, delete on table public.webhook_deliveries to service_role;

alter table public.capi_events add column if not exists shop_domain text;
alter table public.capi_events add column if not exists event_type text not null default 'Purchase';

update public.capi_events e
   set shop_domain = lower(coalesce(ui.shop_domain, ui.shopify_store_url))
  from public.user_integrations ui
 where ui.clerk_user_id = e.clerk_user_id
   and e.shop_domain is null
   and coalesce(ui.shop_domain, ui.shopify_store_url) is not null;

-- Keep one row per key: a successful send first, then the earliest. Rows whose
-- shop cannot be determined are left alone (NULLs never collide in the index).
delete from public.capi_events
 where id in (
   select id from (
     select id, row_number() over (
       partition by shop_domain, shopify_order_id, event_type
       order by (status = 'sent') desc, event_sent_at asc nulls last, id
     ) as rank
     from public.capi_events
     where shop_domain is not null
   ) ranked
   where rank > 1
 );

create unique index if not exists capi_events_business_key
  on public.capi_events (shop_domain, shopify_order_id, event_type);
