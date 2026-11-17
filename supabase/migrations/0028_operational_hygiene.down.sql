-- Reverses 0028. Rows already pruned are not restored (they had no further use).
drop function if exists public.brief_nudge_candidates(timestamptz, integer);
drop function if exists public.release_email_claim(uuid);
drop function if exists public.claim_email_send(text, text, interval);
drop function if exists public.prune_operational_rows();
drop index if exists public.rate_limits_window_idx;
drop index if exists public.api_usage_log_user_idx;
drop index if exists public.credit_usage_user_idx;
drop index if exists public.payments_user_idx;
drop index if exists public.capi_events_user_idx;
