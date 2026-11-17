-- 0028: missing indexes, operational cleanup, race-free email claims and a
-- single brief-nudge query (Phase 1, task 10; DATA-07). Additive.

-- Account deletion, shop redaction and legacy reconciliation filter these by user.
create index if not exists capi_events_user_idx on public.capi_events (clerk_user_id);
create index if not exists payments_user_idx on public.payments (clerk_user_id);
create index if not exists credit_usage_user_idx on public.credit_usage (clerk_user_id);
create index if not exists api_usage_log_user_idx on public.api_usage_log (user_id) where user_id is not null;
create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

-- Daily housekeeping (/api/cron/capacity): rows that only exist to rate-limit
-- or deduplicate, once past any use. The longest rate-limit window is an hour;
-- Shopify retries a webhook for 48 hours.
create or replace function public.prune_operational_rows()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rate_limits integer;
  v_deliveries integer;
begin
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_rate_limits = row_count;
  delete from public.webhook_deliveries where received_at < now() - interval '30 days';
  get diagnostics v_deliveries = row_count;
  return jsonb_build_object('rate_limits', v_rate_limits, 'webhook_deliveries', v_deliveries);
end;
$$;

-- One send of a template per user per window, even when two runs overlap:
-- the check and the claim happen under one lock. Returns the claim, or null
-- when the template was already sent (or claimed) inside the window.
create or replace function public.claim_email_send(p_user text, p_template text, p_window interval)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if coalesce(btrim(p_user), '') = '' or coalesce(btrim(p_template), '') = '' or p_window is null then
    raise exception 'email_claim_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:email:' || p_user || ':' || p_template, 0));
  if exists (select 1 from public.email_log where user_id = p_user and template = p_template and sent_at > now() - p_window) then
    return null;
  end if;
  insert into public.email_log (user_id, template) values (p_user, p_template) returning id into v_id;
  return v_id;
end;
$$;

-- Gives a claim back when the email could not be sent, so the next run retries.
create or replace function public.release_email_claim(p_claim uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.email_log where id = p_claim;
$$;

-- Accounts to nudge: connected before the cutoff, no saved brief, not nudged in
-- the last 7 days. One query instead of one per account.
create or replace function public.brief_nudge_candidates(p_created_before timestamptz, p_limit integer)
returns setof text language sql stable security definer set search_path = public, pg_temp as $$
  select ui.clerk_user_id
    from public.user_integrations ui
   where ui.clerk_user_id is not null and ui.created_at <= p_created_before
     and not exists (select 1 from public.campaigns c where c.clerk_user_id = ui.clerk_user_id)
     and not exists (select 1 from public.email_log e
                      where e.user_id = ui.clerk_user_id and e.template = 'brief-nudge' and e.sent_at > now() - interval '7 days')
   order by ui.created_at, ui.clerk_user_id
   limit greatest(least(coalesce(p_limit, 0), 500), 0);
$$;

revoke all on function public.prune_operational_rows(), public.claim_email_send(text, text, interval),
  public.release_email_claim(uuid), public.brief_nudge_candidates(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.prune_operational_rows(), public.claim_email_send(text, text, interval),
  public.release_email_claim(uuid), public.brief_nudge_candidates(timestamptz, integer) to service_role;
