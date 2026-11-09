-- 0019: durable per-shop leases (Phase 1, task 3.1).
--
-- Shopify keeps one current offline token per app and store: exchanging an
-- OAuth code retires the shop's earlier tokens. An installation therefore
-- holds an 'install' lease on the shop's Shopify-verified myshopify domain
-- (the only shop identifier available before the exchange) from before the
-- ownership check until its binding commits. A second account cannot reach
-- the exchange while ownership is being decided, and a callback whose lease
-- was taken over after expiry commits nothing.
--
-- A lease is identified by its holder, a random id per acquisition. It can be
-- taken over only once expired, and a commit succeeds only while the lease
-- still names the committing holder. Task 4 adds 'refresh' leases.
--
-- Additive. Leaves migration 0018 unchanged.

create table public.shop_leases (
  lease_key    text primary key check (btrim(lease_key) <> ''),
  purpose      text not null check (purpose in ('install', 'refresh')),
  holder       uuid not null,
  actor        text,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  constraint shop_leases_expiry check (expires_at > acquired_at)
);

create or replace function public.install_lease_key(p_domain text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select 'install:' || public.myshopify_domain_or_null(p_domain);
$$;

-- Returns the new holder id, or null while another live lease holds the key.
create or replace function public.acquire_shop_lease(p_key text, p_purpose text, p_actor text, p_ttl_seconds integer)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_holder uuid;
begin
  if p_key is null or btrim(p_key) = '' or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 600 then
    raise exception 'invalid_lease_request';
  end if;
  insert into public.shop_leases as l (lease_key, purpose, holder, actor, expires_at)
  values (p_key, p_purpose, gen_random_uuid(), p_actor, now() + make_interval(secs => p_ttl_seconds))
  on conflict (lease_key) do update
     set purpose = excluded.purpose, holder = excluded.holder, actor = excluded.actor,
         acquired_at = now(), expires_at = excluded.expires_at
   where l.expires_at <= now()
  returning holder into v_holder;
  return v_holder;
end;
$$;

create or replace function public.release_shop_lease(p_key text, p_holder uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.shop_leases where lease_key = p_key and holder = p_holder;
  return found;
end;
$$;

-- Internal. True while the lease still names this holder; the row stays locked
-- until the caller's transaction ends, so no takeover can interleave with the
-- work it guards. An expired lease nobody has taken over is still held.
create or replace function public.hold_shop_lease(p_key text, p_holder uuid)
returns boolean language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.shop_leases where lease_key = p_key and holder = p_holder for update;
  return found;
end;
$$;

create or replace function public.shop_lease_held(p_key text, p_holder uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.shop_leases where lease_key = p_key and holder = p_holder);
$$;

-- The pre-exchange decision, made only while holding the install lease:
-- ownership for a connection, or an approved transfer for a completion.
create or replace function public.connect_check_under_lease(p_lease_domain text, p_holder uuid, p_actor text, p_transfer uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(p_lease_domain);
begin
  if v_domain is null or not public.hold_shop_lease(public.install_lease_key(v_domain), p_holder) then
    return jsonb_build_object('outcome', 'rejected_lease_lost');
  end if;
  if p_transfer is null then
    return public.shop_connection_preflight(v_domain, p_actor);
  end if;
  if exists (
    select 1 from public.ownership_transfers t join public.shops s on s.id = t.shop_id
     where t.id = p_transfer and t.requested_by_clerk_user_id = p_actor and t.status = 'approved'
       and t.expires_at > now() and s.myshopify_domain = v_domain
  ) then
    return jsonb_build_object('outcome', 'allowed');
  end if;
  return jsonb_build_object('outcome', 'rejected_transfer_not_ready');
end;
$$;

-- Binds after the exchange, in the same transaction that proves the lease is
-- still this callback's.
create or replace function public.bind_shop_under_lease(
  p_lease_domain text, p_holder uuid, p_shopify_shop_id bigint, p_domain text, p_actor text,
  p_selected_workspace uuid default null, p_shop_name text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.hold_shop_lease(public.install_lease_key(p_lease_domain), p_holder) then
    return jsonb_build_object('outcome', 'rejected_lease_lost');
  end if;
  return public.bind_shop_for_install(p_shopify_shop_id, p_domain, p_actor, p_selected_workspace, p_shop_name);
end;
$$;

create or replace function public.complete_transfer_under_lease(
  p_lease_domain text, p_holder uuid, p_transfer uuid, p_requester text, p_shopify_shop_id bigint
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.hold_shop_lease(public.install_lease_key(p_lease_domain), p_holder) then
    return jsonb_build_object('outcome', 'rejected_lease_lost');
  end if;
  return public.complete_ownership_transfer(p_transfer, p_requester, p_shopify_shop_id);
end;
$$;

-- shop/update: follows a myshopify domain change by the immutable shop id, so
-- the pre-exchange check keeps finding the owner of a renamed shop.
create or replace function public.record_shop_update(p_shopify_shop_id bigint, p_domain text, p_name text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(p_domain);
  v_shop public.shops%rowtype;
  v_workspace uuid;
begin
  if p_shopify_shop_id is null or p_shopify_shop_id <= 0 or v_domain is null then
    return jsonb_build_object('outcome', 'ignored');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:shop:' || p_shopify_shop_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:domain:' || v_domain, 0));
  select * into v_shop from public.shops where shopify_shop_id = p_shopify_shop_id for update;
  if not found then return jsonb_build_object('outcome', 'unknown_shop'); end if;
  select workspace_id into v_workspace from public.shop_bindings where shop_id = v_shop.id and released_at is null;

  if v_shop.myshopify_domain = v_domain then
    if p_name is not null and p_name is distinct from v_shop.name then
      update public.shops set name = p_name, updated_at = now() where id = v_shop.id;
    end if;
    return jsonb_build_object('outcome', 'unchanged');
  end if;
  if exists (select 1 from public.shops where myshopify_domain = v_domain and id <> v_shop.id) then
    perform public.log_workspace_event(v_workspace, v_shop.id, 'shop_domain_conflict', null, 'webhook', null,
      jsonb_build_object('domain', v_domain));
    return jsonb_build_object('outcome', 'conflict');
  end if;
  update public.shops
     set myshopify_domain = v_domain, domain_changed_at = now(), updated_at = now(), name = coalesce(p_name, name)
   where id = v_shop.id;
  perform public.log_workspace_event(v_workspace, v_shop.id, 'shop_domain_changed', null, 'webhook', null,
    jsonb_build_object('from', v_shop.myshopify_domain, 'to', v_domain));
  return jsonb_build_object('outcome', 'domain_updated');
end;
$$;

alter table public.shop_leases enable row level security;
revoke all on table public.shop_leases from public, anon, authenticated, service_role;
grant select on table public.shop_leases to service_role;

revoke all on function
  public.install_lease_key(text), public.acquire_shop_lease(text, text, text, integer), public.release_shop_lease(text, uuid),
  public.hold_shop_lease(text, uuid), public.shop_lease_held(text, uuid), public.connect_check_under_lease(text, uuid, text, uuid),
  public.bind_shop_under_lease(text, uuid, bigint, text, text, uuid, text),
  public.complete_transfer_under_lease(text, uuid, uuid, text, bigint), public.record_shop_update(bigint, text, text)
from public, anon, authenticated, service_role;

-- From here on the application binds and completes transfers only under a
-- lease, so it loses direct access to the unguarded functions.
revoke execute on function
  public.bind_shop_for_install(bigint, text, text, uuid, text),
  public.complete_ownership_transfer(uuid, text, bigint)
from service_role;

grant execute on function
  public.acquire_shop_lease(text, text, text, integer), public.release_shop_lease(text, uuid), public.shop_lease_held(text, uuid),
  public.connect_check_under_lease(text, uuid, text, uuid), public.bind_shop_under_lease(text, uuid, bigint, text, text, uuid, text),
  public.complete_transfer_under_lease(text, uuid, uuid, text, bigint), public.record_shop_update(bigint, text, text)
to service_role;
