-- Restrict internal helper functions to the service role (complete the lockdown)
--
-- Migrations 0003 and 0004 revoked EXECUTE from PUBLIC, but Supabase also grants
-- EXECUTE to the `anon` and `authenticated` roles explicitly (not only through
-- PUBLIC), so those grants survived and the functions stayed callable with an
-- anon / end-user API key. RLS on the underlying tables already blocked any
-- effect, but these functions are server-only infrastructure and should not be
-- invocable at all from a public key — most importantly increment_credits,
-- which writes to user_integrations.
--
-- Revoke from those roles too and (re)assert the explicit grant to service_role,
-- the only caller. This is a roll-forward correction to the partial revokes in
-- 0003/0004; re-running the grants is idempotent.

revoke execute on function public.acquire_refresh_lock(text, integer)        from public, anon, authenticated;
revoke execute on function public.release_refresh_lock(text)                 from public, anon, authenticated;
revoke execute on function public.increment_credits(text, integer, integer)  from public, anon, authenticated;
revoke execute on function public.check_rate_limit(text, integer, integer)   from public, anon, authenticated;

grant execute on function public.acquire_refresh_lock(text, integer)        to service_role;
grant execute on function public.release_refresh_lock(text)                 to service_role;
grant execute on function public.increment_credits(text, integer, integer)  to service_role;
grant execute on function public.check_rate_limit(text, integer, integer)   to service_role;
