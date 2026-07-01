-- Shopify token-refresh distributed lock
--
-- Serializes refresh-token rotation across serverless instances. Shopify
-- refresh tokens are single-use and rotate on every refresh, so two instances
-- refreshing at once burn the token (the loser sends an already-consumed token
-- and gets a 401). The in-process guard in src/lib/shopify-token.ts only
-- dedupes within a single runtime; this lease-based lock covers the
-- cross-instance race.
--
-- The application FAILS OPEN if these objects are missing (it degrades to the
-- in-process guard only), so deploy ordering will not break Shopify calls.

create table if not exists public.shopify_refresh_locks (
  user_id      text primary key,
  locked_until timestamptz not null
);

-- Acquire a short lease for p_user_id. Returns true when acquired (no row
-- existed, or the prior lease had already expired), false when another holder's
-- lease is still active. The INSERT ... ON CONFLICT is a single atomic
-- statement, so concurrent callers cannot both acquire: the row lock serializes
-- them and the conditional DO UPDATE only "steals" an expired lease.
create or replace function public.acquire_refresh_lock(
  p_user_id     text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
as $$
declare
  v_acquired boolean;
begin
  insert into public.shopify_refresh_locks as l (user_id, locked_until)
  values (p_user_id, now() + make_interval(secs => p_ttl_seconds))
  on conflict (user_id) do update
    set locked_until = excluded.locked_until
    where l.locked_until < now()
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.release_refresh_lock(p_user_id text)
returns void
language sql
as $$
  delete from public.shopify_refresh_locks where user_id = p_user_id;
$$;

-- Lock the table and its helpers to the server (service-role) only -----------
-- This table and the two functions above are internal infrastructure: the app
-- touches them solely through the service-role key, which bypasses RLS.
-- Enabling RLS with no policies denies the anon/authenticated roles by default
-- (defense in depth if the table is ever exposed through PostgREST), and the
-- revoke/grant restricts the lock functions to the service role so they cannot
-- be invoked with an end-user or anon API key.
alter table public.shopify_refresh_locks enable row level security;

revoke execute on function public.acquire_refresh_lock(text, integer) from public;
revoke execute on function public.release_refresh_lock(text)          from public;
grant  execute on function public.acquire_refresh_lock(text, integer) to service_role;
grant  execute on function public.release_refresh_lock(text)          to service_role;
