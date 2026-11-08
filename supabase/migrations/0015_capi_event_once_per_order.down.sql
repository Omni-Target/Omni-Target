-- Roll back 0015: remove the unique key. Deleted duplicate log rows are not restored.
drop index if exists public.capi_events_user_order_key;
