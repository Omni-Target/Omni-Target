-- Security lockdown of the public schema for client API roles (Phase S0.2, SEC-02)
--
-- The application reaches Postgres exclusively through the service-role key
-- (supabaseAdmin in src/lib/db.ts), which carries BYPASSRLS. Supabase Auth,
-- Storage, Realtime and Edge Functions are not used, and no client bundle uses
-- the anon/publishable key. The client roles `anon` and `authenticated`
-- therefore need no access to anything in `public`.
--
-- Earlier migrations enabled RLS only on internal tables; the core tables
-- (user_integrations — which stores Shopify/Meta tokens — campaigns, payments,
-- capi_events, credit_usage, api_usage_log, …) were created by bootstrap SQL
-- without RLS, while Supabase grants ALL on public tables to anon/authenticated
-- by default. This migration closes that gap regardless of how the live
-- database drifted from the repository SQL:
--
--   1. Records the current client-role privileges and RLS state of every
--      object in `public` (security_lockdown_0012_state) so the companion
--      .down.sql can restore privileges exactly.
--   2. Enables RLS on every table in `public` (no policies => deny by default).
--   3. Revokes all table, sequence and function privileges from anon and
--      authenticated, and EXECUTE on functions from PUBLIC; removes the
--      default privileges that would re-grant them on future objects.
--   4. Re-asserts EXECUTE for service_role on every public function.
--   5. Adds public.keepalive_ping(), the ONLY object callable with the anon
--      key, so the existing GitHub keep-alive keeps working until the nightly
--      backup job (Phase S2.3) replaces it. Returns a constant; reads nothing.
--
-- Server behaviour is unchanged: service_role bypasses RLS and keeps explicit
-- grants. NOTE for future migrations: new functions no longer receive EXECUTE
-- via PUBLIC; grant it to service_role explicitly (as 0009/0010 already do).
--
-- Safe to re-run: every step is idempotent.

-- ── 1. Record prior state ────────────────────────────────────────────────────
create table if not exists public.security_lockdown_0012_state (
  object_type        text        not null,  -- table | sequence | function
  object_name        text        not null,  -- relname, or regprocedure text for functions
  role_name          text        not null,
  privileges         text[]      not null default '{}',
  rls_enabled_before boolean,
  recorded_at        timestamptz not null default now(),
  primary key (object_type, object_name, role_name)
);

do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = client_role) then
      continue;
    end if;

    insert into public.security_lockdown_0012_state
      (object_type, object_name, role_name, privileges, rls_enabled_before)
    select 'table', c.relname, client_role,
           array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                  where has_table_privilege(client_role, c.oid, p)),
           c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and c.relname <> 'security_lockdown_0012_state'
    on conflict (object_type, object_name, role_name) do nothing;

    insert into public.security_lockdown_0012_state
      (object_type, object_name, role_name, privileges)
    select 'sequence', c.relname, client_role,
           array(select p from unnest(array['USAGE','SELECT','UPDATE']) p
                  where has_sequence_privilege(client_role, c.oid, p))
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
    on conflict (object_type, object_name, role_name) do nothing;

    insert into public.security_lockdown_0012_state
      (object_type, object_name, role_name, privileges)
    select 'function', p.oid::regprocedure::text, client_role,
           case when has_function_privilege(client_role, p.oid, 'EXECUTE')
                then array['EXECUTE'] else '{}'::text[] end
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and p.proname <> 'keepalive_ping'
    on conflict (object_type, object_name, role_name) do nothing;
  end loop;
end $$;

-- ── 2. RLS on every table (deny-by-default: no policies are created) ─────────
do $$
declare
  t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end $$;

-- ── 3. Revoke client-role privileges, now and for future objects ─────────────
revoke execute on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;

do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = client_role) then
      continue;
    end if;
    execute format('revoke all on all tables in schema public from %I', client_role);
    execute format('revoke all on all sequences in schema public from %I', client_role);
    execute format('revoke all on all functions in schema public from %I', client_role);
    execute format('alter default privileges in schema public revoke all on tables from %I', client_role);
    execute format('alter default privileges in schema public revoke all on sequences from %I', client_role);
    execute format('alter default privileges in schema public revoke all on functions from %I', client_role);
  end loop;
end $$;

-- ── 4. Server role keeps EXECUTE on every function ───────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on all functions in schema public to service_role;
    alter default privileges in schema public grant execute on functions to service_role;
  end if;
end $$;

-- ── 5. Keep-alive endpoint (temporary; removed when S2.3 backups replace it) ─
create or replace function public.keepalive_ping()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 1 $$;

revoke all on function public.keepalive_ping() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.keepalive_ping() to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.keepalive_ping() to service_role;
  end if;
end $$;

comment on function public.keepalive_ping() is
  'Temporary anon-callable keep-alive for the Supabase Free plan (S0.2). Returns 1, reads nothing. Remove once nightly backups (S2.3) provide database activity.';
