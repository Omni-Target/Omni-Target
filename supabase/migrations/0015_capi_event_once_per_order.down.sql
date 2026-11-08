-- Roll back 0015. Deleted duplicate log rows are not restored. The added
-- capi_events columns are dropped and delivery history is discarded.
drop index if exists public.capi_events_business_key;
alter table public.capi_events drop column if exists event_type;
alter table public.capi_events drop column if exists shop_domain;
drop table if exists public.webhook_deliveries;
