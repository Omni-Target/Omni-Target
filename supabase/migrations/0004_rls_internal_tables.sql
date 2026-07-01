-- Row-level security for the Wave 1/2 infrastructure tables
--
-- processed_payments (0001) and rate_limits (0002) are internal bookkeeping
-- tables. The application only ever touches them through the service-role key,
-- which bypasses RLS. Those earlier migrations created the tables without RLS;
-- enable it now so that — with no policies defined — the anon/authenticated
-- roles are denied by default. This is defense in depth: if either table is
-- ever accidentally exposed through PostgREST, a public API key reaches nothing.
--
-- The helper functions are likewise restricted to the service role. None of
-- this changes server behaviour: the server authenticates as service_role,
-- which both bypasses RLS and keeps an explicit EXECUTE grant below.

alter table public.processed_payments enable row level security;
alter table public.rate_limits        enable row level security;

revoke execute on function public.increment_credits(text, integer, integer) from public;
revoke execute on function public.check_rate_limit(text, integer, integer)   from public;
grant  execute on function public.increment_credits(text, integer, integer) to service_role;
grant  execute on function public.check_rate_limit(text, integer, integer)   to service_role;
