-- Reverses 0040: the sync functions, the thin-payload constraint and the claim columns are dropped.
-- Events recorded meanwhile stay in webhook_events (their payloads were thin).
drop function public.save_sync_watermark(integer, text, timestamptz);
drop function public.delete_synced_records(integer, text, bigint[]);
drop function public.sync_shops_due(integer);
drop function public.finish_sync_events(text, uuid[], jsonb, integer);
drop function public.claim_sync_events(integer, text, integer, integer);
drop function public.record_sync_events(text, jsonb);
alter table public.webhook_events drop constraint webhook_events_thin_payload;
drop function public.thin_event_payload(jsonb);
drop function public.is_thin_event_payload(jsonb);
drop index public.webhook_events_claimable_idx;
alter table public.webhook_events drop column next_attempt_at, drop column claimed_at, drop column claimed_by;
