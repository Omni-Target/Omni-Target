-- 0033: concurrency-safe import capacity reservations (Phase 2, task 5).
--
-- Before an import writes anything it reserves the bytes its projection says
-- it will add. Reservations are granted under one transaction-scoped advisory
-- lock, so two imports reserving at the same moment are serialised: the
-- second sees the first's reservation. A reservation is granted only if
--
--   current database size + every active reservation's unwritten bytes
--   + the new request  <=  quota x critical share
--
-- While it runs, an import renews its reservation with the bytes it has
-- written (so they are not counted twice) and learns whether the database has
-- actually passed the limit, in which case it stops. A reservation a crashed
-- worker abandons expires; a retry for the same shop and purpose gets the
-- active reservation back rather than a second one.
--
-- Keyed by the shop's UUID: reservations are capacity history, kept like sync
-- and ownership history after a shop is deleted. Changes no existing rows.

create table public.capacity_reservations (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops (id),
  purpose         text not null check (purpose in ('initial_import', 'history_import', 'reconcile')),
  reserved_bytes  bigint not null check (reserved_bytes > 0),
  written_bytes   bigint not null default 0 check (written_bytes >= 0),
  projection      jsonb not null default '{}' check (jsonb_typeof(projection) = 'object' and pg_column_size(projection) <= 4096),
  created_at      timestamptz not null default now(),
  renewed_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  released_at     timestamptz,
  release_reason  text check (release_reason in ('completed', 'failed', 'cancelled', 'expired')),
  check (expires_at > created_at),
  check ((released_at is null) = (release_reason is null))
);
create unique index capacity_reservations_one_active_idx on public.capacity_reservations (shop_id, purpose) where released_at is null;
create index capacity_reservations_active_idx on public.capacity_reservations (expires_at) where released_at is null;

create or replace function public.reserve_import_capacity(
  p_shop_key integer, p_purpose text, p_bytes bigint, p_quota_bytes bigint, p_critical_share numeric,
  p_ttl_seconds integer default 3600, p_projection jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop uuid;
  v_existing public.capacity_reservations;
  v_used bigint;
  v_outstanding bigint;
  v_limit bigint;
  v_id uuid;
begin
  if p_bytes is null or p_bytes <= 0 or p_quota_bytes is null or p_quota_bytes <= 0
     or p_critical_share is null or p_critical_share <= 0 or p_critical_share > 1
     or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'capacity_request_invalid';
  end if;
  select id into v_shop from public.shops where shop_key = p_shop_key;
  if v_shop is null then raise exception 'shop_not_found'; end if;

  -- One reservation decision at a time, database-wide, until this transaction ends.
  perform pg_advisory_xact_lock(hashtext('public.capacity_reservations'));

  update public.capacity_reservations set released_at = now(), release_reason = 'expired'
   where released_at is null and expires_at <= now();

  select * into v_existing from public.capacity_reservations
   where shop_id = v_shop and purpose = p_purpose and released_at is null;
  if found then
    update public.capacity_reservations set expires_at = now() + make_interval(secs => p_ttl_seconds), renewed_at = now()
     where id = v_existing.id;
    return jsonb_build_object('outcome', 'reserved', 'reservation_id', v_existing.id, 'existing', true,
      'reserved_bytes', v_existing.reserved_bytes, 'written_bytes', v_existing.written_bytes);
  end if;

  v_used := pg_database_size(current_database());
  select coalesce(sum(greatest(reserved_bytes - written_bytes, 0)), 0) into v_outstanding
    from public.capacity_reservations where released_at is null;
  v_limit := floor(p_quota_bytes * p_critical_share);

  if v_used + v_outstanding + p_bytes > v_limit then
    return jsonb_build_object('outcome', 'refused', 'reason', 'capacity_exceeded', 'used_bytes', v_used,
      'outstanding_bytes', v_outstanding, 'requested_bytes', p_bytes, 'limit_bytes', v_limit);
  end if;

  insert into public.capacity_reservations (shop_id, purpose, reserved_bytes, projection, expires_at)
  values (v_shop, p_purpose, p_bytes, coalesce(p_projection, '{}'), now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return jsonb_build_object('outcome', 'reserved', 'reservation_id', v_id, 'existing', false, 'used_bytes', v_used,
    'outstanding_bytes', v_outstanding, 'requested_bytes', p_bytes, 'limit_bytes', v_limit);
end;
$$;

-- Records progress, extends the lease, and reports whether the database has passed the limit.
create or replace function public.renew_import_capacity(p_reservation uuid, p_written_bytes bigint, p_quota_bytes bigint,
  p_critical_share numeric, p_ttl_seconds integer default 3600)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.capacity_reservations;
  v_used bigint := pg_database_size(current_database());
  v_limit bigint := floor(p_quota_bytes * p_critical_share);
begin
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then raise exception 'capacity_request_invalid'; end if;
  update public.capacity_reservations
     set written_bytes = greatest(written_bytes, coalesce(p_written_bytes, 0)), renewed_at = now(),
         expires_at = now() + make_interval(secs => p_ttl_seconds)
   where id = p_reservation and released_at is null
  returning * into v_row;
  if not found then
    return jsonb_build_object('outcome', case when exists (select 1 from public.capacity_reservations where id = p_reservation) then 'released' else 'missing' end,
      'used_bytes', v_used, 'limit_bytes', v_limit, 'over_limit', v_used > v_limit);
  end if;
  return jsonb_build_object('outcome', 'renewed', 'used_bytes', v_used, 'limit_bytes', v_limit, 'over_limit', v_used > v_limit,
    'reserved_bytes', v_row.reserved_bytes, 'written_bytes', v_row.written_bytes);
end;
$$;

create or replace function public.release_import_capacity(p_reservation uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_reason not in ('completed', 'failed', 'cancelled') then raise exception 'capacity_request_invalid'; end if;
  update public.capacity_reservations set released_at = now(), release_reason = p_reason
   where id = p_reservation and released_at is null;
  return jsonb_build_object('outcome', case when found then 'released' else 'already_released' end);
end;
$$;

alter table public.capacity_reservations enable row level security;
revoke all on table public.capacity_reservations from public, anon, authenticated, service_role;
grant select on table public.capacity_reservations to service_role;
revoke all on function public.reserve_import_capacity(integer, text, bigint, bigint, numeric, integer, jsonb),
  public.renew_import_capacity(uuid, bigint, bigint, numeric, integer), public.release_import_capacity(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reserve_import_capacity(integer, text, bigint, bigint, numeric, integer, jsonb),
  public.renew_import_capacity(uuid, bigint, bigint, numeric, integer), public.release_import_capacity(uuid, text)
  to service_role;
