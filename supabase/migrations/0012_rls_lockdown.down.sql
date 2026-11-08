-- Rollback for 0012_rls_lockdown.sql
--
-- Restores exactly the client-role (anon/authenticated) privileges that were
-- recorded in public.security_lockdown_0012_state before the lockdown, then
-- removes the keep-alive function and the state table.
--
-- Deliberately NOT restored:
--   * RLS stays enabled. The server uses service_role (BYPASSRLS), so RLS can
--     never be the cause of an application failure, and disabling it would
--     re-open direct table exposure through the public API key.
--   * Default privileges for future objects and EXECUTE-via-PUBLIC are not
--     re-granted; they only affect objects created after this point, and the
--     effective privileges of anon/authenticated on existing objects are
--     restored below as explicit grants.

do $$
declare
  s record;
begin
  if to_regclass('public.security_lockdown_0012_state') is null then
    raise notice '0012 state table missing; nothing to restore';
    return;
  end if;

  for s in
    select * from public.security_lockdown_0012_state
     where cardinality(privileges) > 0
       and exists (select 1 from pg_roles where rolname = role_name)
  loop
    if s.object_type = 'table' and to_regclass(format('public.%I', s.object_name)) is not null then
      execute format('grant %s on public.%I to %I', array_to_string(s.privileges, ', '), s.object_name, s.role_name);
    elsif s.object_type = 'sequence' and to_regclass(format('public.%I', s.object_name)) is not null then
      execute format('grant %s on sequence public.%I to %I', array_to_string(s.privileges, ', '), s.object_name, s.role_name);
    elsif s.object_type = 'function' and to_regprocedure(s.object_name) is not null then
      execute format('grant execute on function %s to %I', s.object_name, s.role_name);
    end if;
  end loop;
end $$;

drop function if exists public.keepalive_ping();
drop table if exists public.security_lockdown_0012_state;
