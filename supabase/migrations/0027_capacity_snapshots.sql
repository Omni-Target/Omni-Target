-- 0027: daily capacity snapshots (Phase 1, task 10).
--
-- One row per capture: the database's size, the application schema's size,
-- the plan's quota at the time, and the 30 largest tables (rows, heap, index
-- and total bytes). Captured by /api/cron/capacity in production and by
-- pg_cron on staging (scripts/ops/staging-capacity-schedule.sql). Snapshots
-- older than 400 days are removed by the capture itself. Sizes and row counts
-- only; no application data.

create table public.db_capacity_snapshots (
  id              bigint generated always as identity primary key,
  captured_at     timestamptz not null default now(),
  database_bytes  bigint not null check (database_bytes >= 0),
  public_bytes    bigint not null check (public_bytes >= 0),
  quota_bytes     bigint not null check (quota_bytes > 0),
  tables          jsonb not null check (jsonb_typeof(tables) = 'array' and pg_column_size(tables) <= 32768)
);
create index db_capacity_snapshots_captured_idx on public.db_capacity_snapshots (captured_at desc);

create or replace function public.capture_capacity_snapshot(p_quota_bytes bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.db_capacity_snapshots%rowtype;
begin
  if p_quota_bytes is null or p_quota_bytes <= 0 then raise exception 'quota_required'; end if;
  insert into public.db_capacity_snapshots (database_bytes, public_bytes, quota_bytes, tables)
  select pg_database_size(current_database()),
         (select coalesce(sum(pg_total_relation_size(c.oid)), 0) from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'm')),
         p_quota_bytes,
         coalesce((select jsonb_agg(t.entry order by t.total desc) from (
           select pg_total_relation_size(c.oid) as total,
                  jsonb_build_object('table', c.relname, 'rows', greatest(c.reltuples, 0)::bigint, 'heap', pg_relation_size(c.oid),
                                     'indexes', pg_indexes_size(c.oid), 'total', pg_total_relation_size(c.oid)) as entry
             from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
            order by pg_total_relation_size(c.oid) desc limit 30) t), '[]'::jsonb)
  returning * into v_row;
  delete from public.db_capacity_snapshots where captured_at < now() - interval '400 days';
  return jsonb_build_object(
    'captured_at', v_row.captured_at, 'database_bytes', v_row.database_bytes, 'public_bytes', v_row.public_bytes,
    'quota_bytes', v_row.quota_bytes, 'used_share', round(v_row.database_bytes::numeric / v_row.quota_bytes, 4),
    'largest', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_row.tables) e limit 5) s));
end;
$$;

-- The database's current size, for the import pre-flight check.
create or replace function public.database_size_bytes()
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select pg_database_size(current_database());
$$;

alter table public.db_capacity_snapshots enable row level security;
revoke all on table public.db_capacity_snapshots from public, anon, authenticated, service_role;
grant select on table public.db_capacity_snapshots to service_role;
revoke all on function public.capture_capacity_snapshot(bigint), public.database_size_bytes() from public, anon, authenticated;
grant execute on function public.capture_capacity_snapshot(bigint), public.database_size_bytes() to service_role;
