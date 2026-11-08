-- ING-05 (Phase S1): a Meta Purchase event is sent at most once per order.
-- The webhook route claims a row here before sending, so this key is what makes
-- a redelivered or concurrent webhook a no-op.
--
-- capi_events is a send log with no other dependents. Existing duplicates must
-- go before the index can exist: one row per (user, order) is kept, preferring
-- a successful send, then the earliest.
delete from public.capi_events
 where id in (
   select id from (
     select id, row_number() over (
       partition by clerk_user_id, shopify_order_id
       order by (status = 'sent') desc, event_sent_at asc nulls last, id
     ) as rank
     from public.capi_events
   ) ranked
   where rank > 1
 );

create unique index if not exists capi_events_user_order_key
  on public.capi_events (clerk_user_id, shopify_order_id);
