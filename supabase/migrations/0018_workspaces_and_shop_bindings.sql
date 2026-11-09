-- 0018: workspaces, canonical Shopify shops and one-to-one bindings (Phase 1, task 3).
-- Implements architecture/decisions/0001-one-shop-one-workspace.md.
--
-- Additive: creates new tables and functions, and one nullable column on
-- campaigns. No existing row changes. Legacy user_integrations stays the
-- credential and balance source until tasks 4 and 5 move them.
--
-- The application role (service_role) may read these tables but change them
-- only through the functions below, which run with their owner's rights
-- (security definer). Every invariant therefore lives in one place.

create or replace function public.myshopify_domain_or_null(p_value text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case when d ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then d end
    from (select regexp_replace(regexp_replace(lower(btrim(coalesce(p_value, ''))), '^https?://', ''), '/+$', '') as d) s;
$$;

create or replace function public.reject_row_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'append_only_table: %', tg_table_name;
end;
$$;

-- Workspaces: the Omnitarget account that owns data. One owner each.
create table public.workspaces (
  id                          uuid primary key default gen_random_uuid(),
  owner_clerk_user_id         text not null check (btrim(owner_clerk_user_id) <> ''),
  status                      text not null default 'active'
                              check (status in ('active', 'disconnected', 'pending_deletion', 'deletion_processing', 'deleted')),
  created_at                  timestamptz not null default now(),
  status_changed_at           timestamptz not null default now(),
  last_connected_at           timestamptz,
  uninstalled_at              timestamptz,
  deletion_requested_at       timestamptz,
  recovery_ends_at            timestamptz,
  deleted_at                  timestamptz,
  legacy_user_integration_id  uuid unique,
  constraint workspaces_deleted_at check ((status = 'deleted') = (deleted_at is not null))
);
create index workspaces_owner_idx on public.workspaces (owner_clerk_user_id) where status <> 'deleted';

-- One balance per workspace. Task 5 adds the ledger that changes it.
create table public.credit_accounts (
  workspace_id  uuid primary key references public.workspaces (id),
  balance       integer not null default 0 check (balance >= 0),
  updated_at    timestamptz not null default now()
);

create or replace function public.create_credit_account()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  insert into public.credit_accounts (workspace_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
create trigger workspaces_credit_account after insert on public.workspaces
  for each row execute function public.create_credit_account();

-- Shops: identified by Shopify's immutable ID. The domain is unique but can change.
create table public.shops (
  id                 uuid primary key default gen_random_uuid(),
  shopify_shop_id    bigint not null unique check (shopify_shop_id > 0),
  -- "is not distinct from": an invalid domain maps to null, which a plain = would let through.
  myshopify_domain   text not null unique check (public.myshopify_domain_or_null(myshopify_domain) is not distinct from myshopify_domain),
  name               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  domain_changed_at  timestamptz
);

-- Bindings: at most one current binding per shop and per workspace. Released
-- rows are history and are never deleted.
create table public.shop_bindings (
  id                      uuid primary key default gen_random_uuid(),
  shop_id                 uuid not null references public.shops (id),
  workspace_id            uuid not null references public.workspaces (id),
  bound_at                timestamptz not null default now(),
  bound_by_clerk_user_id  text not null,
  released_at             timestamptz,
  release_reason          text check (release_reason in ('deletion_completed', 'ownership_transferred')),
  transfer_id             uuid,
  constraint shop_bindings_release check ((released_at is null) = (release_reason is null))
);
create unique index shop_bindings_current_shop on public.shop_bindings (shop_id) where released_at is null;
create unique index shop_bindings_current_workspace on public.shop_bindings (workspace_id) where released_at is null;
create index shop_bindings_workspace_idx on public.shop_bindings (workspace_id);

-- Audit trail, append-only.
create table public.workspace_events (
  id                   bigint generated always as identity primary key,
  workspace_id         uuid references public.workspaces (id),
  shop_id              uuid references public.shops (id),
  event                text not null,
  actor_clerk_user_id  text,
  source               text not null check (source in ('oauth', 'webhook', 'user', 'system', 'support', 'migration')),
  occurred_at          timestamptz,
  recorded_at          timestamptz not null default now(),
  details              jsonb not null default '{}'::jsonb
);
create index workspace_events_workspace_idx on public.workspace_events (workspace_id, recorded_at);
create trigger workspace_events_append_only before update or delete on public.workspace_events
  for each row execute function public.reject_row_mutation();

-- Shopify lifecycle webhooks as received. One row per delivery key, so a
-- repeat is recognised; Shopify's trigger time and our receipt time are kept apart.
create table public.shop_lifecycle_events (
  id               bigint generated always as identity primary key,
  topic            text not null check (topic in ('app/uninstalled', 'shop/redact', 'customers/redact', 'customers/data_request')),
  event_key        text not null check (btrim(event_key) <> ''),
  shopify_shop_id  bigint,
  shop_domain      text not null,
  triggered_at     timestamptz,
  received_at      timestamptz not null default now(),
  workspace_id     uuid references public.workspaces (id),
  outcome          text,
  unique (topic, event_key)
);

-- Compliance requests, kept until resolved and never discarded.
create table public.compliance_requests (
  id                  uuid primary key default gen_random_uuid(),
  lifecycle_event_id  bigint not null unique references public.shop_lifecycle_events (id),
  topic               text not null,
  shopify_shop_id     bigint,
  shop_domain         text not null,
  workspace_id        uuid references public.workspaces (id),
  received_at         timestamptz not null,
  due_at              timestamptz not null,
  status              text not null default 'open' check (status in ('open', 'processing', 'completed')),
  resolution          text,
  completed_at        timestamptz,
  constraint compliance_requests_completion check ((status = 'completed') = (completed_at is not null))
);
create index compliance_requests_open_idx on public.compliance_requests (due_at) where status <> 'completed';

-- Durable deletion workflow, retried until verified.
create table public.workspace_deletions (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces (id),
  compliance_request_id  uuid references public.compliance_requests (id),
  reason                 text not null check (reason in ('shop_redact')),
  status                 text not null default 'pending' check (status in ('pending', 'failed', 'completed')),
  attempts               integer not null default 0,
  last_error             text,
  requested_at           timestamptz not null default now(),
  started_at             timestamptz,
  completed_at           timestamptz,
  due_at                 timestamptz not null,
  verification           jsonb
);
create unique index workspace_deletions_open on public.workspace_deletions (workspace_id) where status <> 'completed';

-- Ownership transfers: requested, verified through Shopify, approved by the owner.
create table public.ownership_transfers (
  id                          uuid primary key default gen_random_uuid(),
  shop_id                     uuid not null references public.shops (id),
  from_workspace_id           uuid not null references public.workspaces (id),
  to_workspace_id             uuid references public.workspaces (id),  -- null until completion creates it
  requested_by_clerk_user_id  text not null,
  reason                      text,
  status                      text not null default 'requested'
                              check (status in ('requested', 'verified', 'approved', 'completed', 'cancelled', 'expired')),
  requested_at                timestamptz not null default now(),
  shopify_verified_at         timestamptz,
  approved_at                 timestamptz,
  approved_by_clerk_user_id   text,
  completed_at                timestamptz,
  closed_at                   timestamptz,
  expires_at                  timestamptz not null default now() + interval '7 days',
  constraint ownership_transfers_distinct check (from_workspace_id <> to_workspace_id)
);
create unique index ownership_transfers_open on public.ownership_transfers (shop_id) where status in ('requested', 'verified', 'approved');

-- Legacy ownership claims. A domain is a claim, never an identity: no shop row
-- is created from it. Confirmation needs an authenticated connection.
create table public.legacy_shop_claims (
  id              uuid primary key default gen_random_uuid(),
  legacy_source   text not null default 'user_integrations',
  legacy_row_id   uuid not null,
  clerk_user_id   text not null,
  claimed_domain  text not null,
  workspace_id    uuid not null references public.workspaces (id),
  status          text not null check (status in ('provisional', 'contested', 'confirmed', 'unresolved', 'rejected')),
  shop_id         uuid references public.shops (id),
  confirmed_at    timestamptz,
  reviewed_by     text,
  review_note     text,
  created_at      timestamptz not null default now(),
  unique (legacy_source, legacy_row_id),
  constraint legacy_shop_claims_confirmation check ((status = 'confirmed') = (shop_id is not null))
);
create index legacy_shop_claims_domain_idx on public.legacy_shop_claims (claimed_domain) where status in ('provisional', 'contested');

-- Campaigns gain their workspace. Visibility stays with the creator.
alter table public.campaigns add column if not exists workspace_id uuid references public.workspaces (id);
create index if not exists campaigns_workspace_idx on public.campaigns (workspace_id) where workspace_id is not null;

-- Legacy redaction (0016), changed in one place: a campaign attributed to a
-- workspace is deleted only with that workspace, never because the same Clerk
-- user also linked the redacted shop.
create or replace function public.redact_shop_data(p_shop text)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare
  shop text := public.normalize_shop_host(p_shop);
  users text[];
  hosts text[];
  assignments text;
  shop_workspaces uuid[];
begin
  if shop is null then return 0; end if;

  select coalesce(array_agg(clerk_user_id), '{}'),
         array_remove(array_agg(distinct public.normalize_shop_host(shopify_custom_domain)), null) || shop
    into users, hosts
    from public.user_integrations
   where shop in (public.normalize_shop_host(shopify_store_url), public.normalize_shop_host(shop_domain));
  hosts := coalesce(hosts, array[shop]);
  select coalesce(array_agg(b.workspace_id), '{}') into shop_workspaces
    from public.shop_bindings b join public.shops s on s.id = b.shop_id
   where s.myshopify_domain = shop and b.released_at is null;

  delete from public.campaigns c
   where (c.workspace_id is null or c.workspace_id = any(shop_workspaces))
     and (public.normalize_shop_host(coalesce(c.brief_data #>> '{storeInsights,store,myshopify_domain}', c.brief_data #>> '{storeInsights,store,domain}')) = any(hosts)
          or (c.clerk_user_id = any(users)
              and public.normalize_shop_host(coalesce(c.brief_data #>> '{storeInsights,store,myshopify_domain}', c.brief_data #>> '{storeInsights,store,domain}')) is null));

  delete from public.brief_generation_receipts where clerk_user_id = any(users);
  delete from public.capi_events where shop_domain = shop or clerk_user_id = any(users);
  delete from public.webhook_deliveries where shop_domain = shop;
  delete from public.shopify_refresh_locks where user_id = any(users);

  update public.payments
     set provider_reference = null
   where clerk_user_id = any(users) and provider = 'shopify'
     and provider_reference is not null and provider_reference not like 'gid://%';

  if cardinality(users) > 0 then
    select string_agg(format('%I = null', column_name), ', ') into assignments
      from information_schema.columns
     where table_schema = 'public' and table_name = 'user_integrations'
       and column_name = any(array['shopify_access_token', 'access_token', 'shopify_refresh_token',
         'refresh_token', 'shopify_token_expires_at', 'token_expires_at', 'shopify_webhook_id',
         'shopify_scopes', 'store_snapshot', 'store_snapshot_at', 'shop_domain',
         'shopify_store_url', 'shopify_custom_domain']);
    execute format('update public.user_integrations set %s where clerk_user_id = any($1)', assignments)
      using users;
  end if;

  return cardinality(users);
end;
$$;

-- Internal helpers, not granted to the application.
create or replace function public.log_workspace_event(
  p_workspace uuid, p_shop uuid, p_event text, p_actor text, p_source text, p_occurred timestamptz, p_details jsonb default '{}'::jsonb
) returns void language sql set search_path = public, pg_temp as $$
  insert into public.workspace_events (workspace_id, shop_id, event, actor_clerk_user_id, source, occurred_at, details)
  values (p_workspace, p_shop, p_event, p_actor, p_source, p_occurred, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function public.shop_has_open_redaction(p_shopify_shop_id bigint, p_domain text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.compliance_requests
     where topic = 'shop/redact' and status <> 'completed'
       and (shopify_shop_id = p_shopify_shop_id or shop_domain = p_domain)
  );
$$;

create or replace function public.find_shop(p_shopify_shop_id bigint, p_domain text)
returns uuid language sql stable set search_path = public, pg_temp as $$
  select id from public.shops
   where (p_shopify_shop_id is not null and shopify_shop_id = p_shopify_shop_id)
      or (p_shopify_shop_id is null and myshopify_domain = public.myshopify_domain_or_null(p_domain))
   limit 1;
$$;

-- Read-only check before the OAuth code exchange, by domain. A rejected account
-- never exchanges a code, so the owner's credential is never retired by it.
create or replace function public.shop_connection_preflight(p_domain text, p_actor text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(p_domain);
  v_owner text;
  v_status text;
  v_claims integer;
  v_claimant text;
begin
  if v_domain is null or coalesce(btrim(p_actor), '') = '' then
    return jsonb_build_object('outcome', 'rejected_invalid_identity');
  end if;
  if public.shop_has_open_redaction(null, v_domain) then
    return jsonb_build_object('outcome', 'rejected_deletion_in_progress');
  end if;
  select w.owner_clerk_user_id, w.status into v_owner, v_status
    from public.shops s
    join public.shop_bindings b on b.shop_id = s.id and b.released_at is null
    join public.workspaces w on w.id = b.workspace_id
   where s.myshopify_domain = v_domain;
  if found then
    if v_owner <> p_actor then return jsonb_build_object('outcome', 'rejected_other_owner'); end if;
    if v_status = 'deletion_processing' then return jsonb_build_object('outcome', 'rejected_deletion_in_progress'); end if;
    return jsonb_build_object('outcome', 'allowed');
  end if;
  select count(*), max(clerk_user_id) filter (where status = 'provisional') into v_claims, v_claimant
    from public.legacy_shop_claims where claimed_domain = v_domain and status in ('provisional', 'contested');
  if v_claims > 1 or exists (select 1 from public.legacy_shop_claims where claimed_domain = v_domain and status = 'contested') then
    return jsonb_build_object('outcome', 'rejected_legacy_claim_under_review');
  end if;
  if v_claims = 1 and v_claimant <> p_actor then
    return jsonb_build_object('outcome', 'rejected_legacy_claim');
  end if;
  return jsonb_build_object('outcome', 'allowed');
end;
$$;

-- Binds a shop after a verified installation. Serialised per shop and domain,
-- so concurrent callbacks cannot create two workspaces or bindings.
create or replace function public.bind_shop_for_install(
  p_shopify_shop_id bigint, p_domain text, p_actor text, p_selected_workspace uuid default null, p_shop_name text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(p_domain);
  v_shop public.shops%rowtype;
  v_binding public.shop_bindings%rowtype;
  v_ws public.workspaces%rowtype;
  v_claim public.legacy_shop_claims%rowtype;
  v_claims integer;
  v_target uuid;
  v_created boolean := false;
begin
  if p_shopify_shop_id is null or p_shopify_shop_id <= 0 or v_domain is null or coalesce(btrim(p_actor), '') = '' then
    return jsonb_build_object('outcome', 'rejected_invalid_identity');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:shop:' || p_shopify_shop_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:domain:' || v_domain, 0));

  if exists (select 1 from public.shops where myshopify_domain = v_domain and shopify_shop_id <> p_shopify_shop_id) then
    perform public.log_workspace_event(null, null, 'connect_rejected', p_actor, 'oauth', null,
      jsonb_build_object('reason', 'domain_belongs_to_another_shop', 'domain', v_domain));
    return jsonb_build_object('outcome', 'rejected_identity_conflict');
  end if;

  select * into v_shop from public.shops where shopify_shop_id = p_shopify_shop_id for update;
  if not found then
    insert into public.shops (shopify_shop_id, myshopify_domain, name) values (p_shopify_shop_id, v_domain, p_shop_name)
    returning * into v_shop;
  elsif v_shop.myshopify_domain <> v_domain then
    update public.shops set myshopify_domain = v_domain, domain_changed_at = now(), updated_at = now()
     where id = v_shop.id returning * into v_shop;
  end if;

  if public.shop_has_open_redaction(p_shopify_shop_id, v_domain) then
    perform public.log_workspace_event(null, v_shop.id, 'connect_rejected', p_actor, 'oauth', null,
      jsonb_build_object('reason', 'redaction_in_progress'));
    return jsonb_build_object('outcome', 'rejected_deletion_in_progress', 'shop_id', v_shop.id);
  end if;

  select * into v_binding from public.shop_bindings where shop_id = v_shop.id and released_at is null for update;
  if found then
    select * into v_ws from public.workspaces where id = v_binding.workspace_id for update;
    if v_ws.owner_clerk_user_id <> p_actor then
      perform public.log_workspace_event(v_ws.id, v_shop.id, 'connect_rejected', p_actor, 'oauth', null,
        jsonb_build_object('reason', 'bound_to_another_workspace'));
      return jsonb_build_object('outcome', 'rejected_other_owner', 'shop_id', v_shop.id);
    end if;
    if v_ws.status = 'deletion_processing' then
      return jsonb_build_object('outcome', 'rejected_deletion_in_progress', 'shop_id', v_shop.id);
    end if;
    if v_ws.status = 'active' then
      update public.workspaces set last_connected_at = now() where id = v_ws.id;
      return jsonb_build_object('outcome', 'already_bound', 'workspace_id', v_ws.id, 'shop_id', v_shop.id);
    end if;
    update public.workspaces
       set status = 'active', status_changed_at = now(), last_connected_at = now(),
           deletion_requested_at = null, recovery_ends_at = null
     where id = v_ws.id;
    perform public.log_workspace_event(v_ws.id, v_shop.id, case when v_ws.status = 'pending_deletion' then 'restored' else 'reconnected' end,
      p_actor, 'oauth', null, jsonb_build_object('previous_status', v_ws.status));
    return jsonb_build_object('outcome', case when v_ws.status = 'pending_deletion' then 'restored' else 'reconnected' end,
      'workspace_id', v_ws.id, 'shop_id', v_shop.id);
  end if;

  -- No current binding. A pending legacy claim decides who may bind.
  select count(*) into v_claims from public.legacy_shop_claims where claimed_domain = v_domain and status in ('provisional', 'contested');
  if v_claims > 0 then
    if v_claims > 1 or exists (select 1 from public.legacy_shop_claims where claimed_domain = v_domain and status = 'contested') then
      perform public.log_workspace_event(null, v_shop.id, 'connect_rejected', p_actor, 'oauth', null,
        jsonb_build_object('reason', 'legacy_claim_under_review'));
      return jsonb_build_object('outcome', 'rejected_legacy_claim_under_review', 'shop_id', v_shop.id);
    end if;
    select * into v_claim from public.legacy_shop_claims where claimed_domain = v_domain and status = 'provisional' for update;
    if v_claim.clerk_user_id <> p_actor then
      perform public.log_workspace_event(null, v_shop.id, 'connect_rejected', p_actor, 'oauth', null,
        jsonb_build_object('reason', 'legacy_claim_by_another_account'));
      return jsonb_build_object('outcome', 'rejected_legacy_claim', 'shop_id', v_shop.id);
    end if;
    v_target := v_claim.workspace_id;
  end if;

  -- An explicitly chosen workspace must be the actor's, active and unbound.
  if v_target is null and p_selected_workspace is not null then
    select * into v_ws from public.workspaces where id = p_selected_workspace for update;
    if not found or v_ws.owner_clerk_user_id <> p_actor or v_ws.status <> 'active'
       or exists (select 1 from public.shop_bindings where workspace_id = v_ws.id and released_at is null) then
      return jsonb_build_object('outcome', 'rejected_workspace_ineligible', 'shop_id', v_shop.id);
    end if;
    v_target := v_ws.id;
  end if;

  if v_target is null then
    insert into public.workspaces (owner_clerk_user_id, last_connected_at) values (p_actor, now()) returning id into v_target;
    v_created := true;
    perform public.log_workspace_event(v_target, v_shop.id, 'provisioned', p_actor, 'oauth', null, '{}'::jsonb);
  end if;

  insert into public.shop_bindings (shop_id, workspace_id, bound_by_clerk_user_id) values (v_shop.id, v_target, p_actor);
  update public.workspaces set status = 'active', status_changed_at = now(), last_connected_at = now() where id = v_target;
  if v_claim.id is not null then
    update public.legacy_shop_claims set status = 'confirmed', shop_id = v_shop.id, confirmed_at = now() where id = v_claim.id;
    perform public.log_workspace_event(v_target, v_shop.id, 'legacy_claim_confirmed', p_actor, 'oauth', null,
      jsonb_build_object('claim_id', v_claim.id));
  end if;
  perform public.log_workspace_event(v_target, v_shop.id, 'connected', p_actor, 'oauth', null, '{}'::jsonb);
  return jsonb_build_object('outcome', case when v_created then 'bound_new_workspace' else 'bound_existing_workspace' end,
    'workspace_id', v_target, 'shop_id', v_shop.id);
end;
$$;

-- Owner disconnects: the binding stays, so the shop is not released.
create or replace function public.disconnect_workspace(p_workspace uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ws public.workspaces%rowtype;
  v_domain text;
begin
  select * into v_ws from public.workspaces where id = p_workspace for update;
  if not found or v_ws.owner_clerk_user_id <> p_actor then raise exception 'workspace_access_denied'; end if;
  select s.myshopify_domain into v_domain from public.shop_bindings b join public.shops s on s.id = b.shop_id
   where b.workspace_id = v_ws.id and b.released_at is null;
  if v_ws.status <> 'active' then
    return jsonb_build_object('outcome', 'not_active', 'status', v_ws.status, 'shop_domain', v_domain);
  end if;
  update public.workspaces set status = 'disconnected', status_changed_at = now() where id = v_ws.id;
  perform public.log_workspace_event(v_ws.id, null, 'disconnected', p_actor, 'user', null, '{}'::jsonb);
  return jsonb_build_object('outcome', 'disconnected', 'workspace_id', v_ws.id, 'shop_domain', v_domain);
end;
$$;

-- app/uninstalled: stop activity, keep the binding, start the recovery window.
-- Idempotent by delivery key; an uninstall triggered before a later
-- reinstall is recorded as stale and changes nothing.
create or replace function public.begin_uninstall(p_shopify_shop_id bigint, p_domain text, p_event_key text, p_triggered_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := coalesce(public.myshopify_domain_or_null(p_domain), lower(btrim(coalesce(p_domain, ''))));
  v_event bigint;
  v_shop uuid;
  v_ws public.workspaces%rowtype;
  v_at timestamptz := coalesce(p_triggered_at, now());
begin
  insert into public.shop_lifecycle_events (topic, event_key, shopify_shop_id, shop_domain, triggered_at)
  values ('app/uninstalled', p_event_key, p_shopify_shop_id, v_domain, p_triggered_at)
  on conflict (topic, event_key) do nothing returning id into v_event;
  -- A retried delivery learns what the first one decided, so the app can finish
  -- its own side of the work (clearing credentials) without redoing anything.
  if v_event is null then
    return jsonb_build_object('outcome', 'duplicate', 'recorded_outcome',
      (select outcome from public.shop_lifecycle_events where topic = 'app/uninstalled' and event_key = p_event_key));
  end if;

  v_shop := public.find_shop(p_shopify_shop_id, v_domain);
  select w.* into v_ws from public.shop_bindings b join public.workspaces w on w.id = b.workspace_id
   where b.shop_id = v_shop and b.released_at is null for update of w;
  if not found then
    update public.shop_lifecycle_events set outcome = 'no_workspace' where id = v_event;
    return jsonb_build_object('outcome', 'no_workspace', 'shop_domain', v_domain);
  end if;
  update public.shop_lifecycle_events set workspace_id = v_ws.id where id = v_event;

  if v_ws.status in ('deletion_processing', 'deleted') then
    update public.shop_lifecycle_events set outcome = 'already_deleting' where id = v_event;
    return jsonb_build_object('outcome', 'already_deleting', 'workspace_id', v_ws.id);
  end if;
  if v_ws.last_connected_at is not null and v_ws.last_connected_at > v_at then
    update public.shop_lifecycle_events set outcome = 'stale' where id = v_event;
    perform public.log_workspace_event(v_ws.id, v_shop, 'uninstall_stale', null, 'webhook', v_at,
      jsonb_build_object('reconnected_at', v_ws.last_connected_at));
    return jsonb_build_object('outcome', 'stale', 'workspace_id', v_ws.id);
  end if;
  if v_ws.status = 'pending_deletion' then
    update public.shop_lifecycle_events set outcome = 'already_pending' where id = v_event;
    return jsonb_build_object('outcome', 'already_pending', 'workspace_id', v_ws.id, 'shop_domain', v_domain);
  end if;

  update public.workspaces
     set status = 'pending_deletion', status_changed_at = now(), uninstalled_at = v_at,
         deletion_requested_at = now(), recovery_ends_at = v_at + interval '48 hours'
   where id = v_ws.id;
  update public.ownership_transfers set status = 'cancelled', closed_at = now()
   where shop_id = v_shop and status in ('requested', 'verified', 'approved');
  update public.shop_lifecycle_events set outcome = 'pending_deletion' where id = v_event;
  perform public.log_workspace_event(v_ws.id, v_shop, 'uninstalled', null, 'webhook', v_at, '{}'::jsonb);
  return jsonb_build_object('outcome', 'pending_deletion', 'workspace_id', v_ws.id, 'shop_domain', v_domain);
end;
$$;

-- shop/redact: always recorded with its deadline, and always acted on. A
-- request arriving after a reinstall still moves the workspace into deletion;
-- reconnection is refused until the deletion completes.
create or replace function public.record_shop_redact(p_shopify_shop_id bigint, p_domain text, p_event_key text, p_triggered_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := coalesce(public.myshopify_domain_or_null(p_domain), lower(btrim(coalesce(p_domain, ''))));
  v_event bigint;
  v_request uuid;
  v_shop uuid;
  v_ws public.workspaces%rowtype;
  v_deletion uuid;
  v_existing boolean := false;
begin
  insert into public.shop_lifecycle_events (topic, event_key, shopify_shop_id, shop_domain, triggered_at)
  values ('shop/redact', p_event_key, p_shopify_shop_id, v_domain, p_triggered_at)
  on conflict (topic, event_key) do nothing returning id into v_event;
  if v_event is null then
    select r.id into v_request from public.compliance_requests r
      join public.shop_lifecycle_events e on e.id = r.lifecycle_event_id where e.topic = 'shop/redact' and e.event_key = p_event_key;
    select id into v_deletion from public.workspace_deletions where compliance_request_id = v_request;
    return jsonb_build_object('outcome', 'duplicate', 'compliance_request_id', v_request, 'deletion_id', v_deletion);
  end if;

  insert into public.compliance_requests (lifecycle_event_id, topic, shopify_shop_id, shop_domain, received_at, due_at)
  values (v_event, 'shop/redact', p_shopify_shop_id, v_domain, now(), now() + interval '30 days')
  returning id into v_request;

  v_shop := public.find_shop(p_shopify_shop_id, v_domain);
  select w.* into v_ws from public.shop_bindings b join public.workspaces w on w.id = b.workspace_id
   where b.shop_id = v_shop and b.released_at is null for update of w;
  if not found then
    update public.shop_lifecycle_events set outcome = 'no_workspace' where id = v_event;
    return jsonb_build_object('outcome', 'no_workspace', 'compliance_request_id', v_request, 'shop_domain', v_domain);
  end if;

  if v_ws.status in ('active', 'disconnected') then
    perform public.log_workspace_event(v_ws.id, v_shop, 'redact_after_reinstall', null, 'webhook', p_triggered_at,
      jsonb_build_object('status_at_receipt', v_ws.status, 'last_connected_at', v_ws.last_connected_at, 'uninstalled_at', v_ws.uninstalled_at));
  end if;
  perform public.log_workspace_event(v_ws.id, v_shop, 'redact_received', null, 'webhook', p_triggered_at,
    jsonb_build_object('compliance_request_id', v_request, 'due_at', now() + interval '30 days'));

  if v_ws.status <> 'deletion_processing' then
    update public.workspaces set status = 'deletion_processing', status_changed_at = now() where id = v_ws.id;
    perform public.log_workspace_event(v_ws.id, v_shop, 'deletion_started', null, 'webhook', null, '{}'::jsonb);
  end if;
  update public.ownership_transfers set status = 'cancelled', closed_at = now()
   where shop_id = v_shop and status in ('requested', 'verified', 'approved');

  select id into v_deletion from public.workspace_deletions where workspace_id = v_ws.id and status <> 'completed';
  if found then
    v_existing := true;
  else
    insert into public.workspace_deletions (workspace_id, compliance_request_id, reason, due_at)
    values (v_ws.id, v_request, 'shop_redact', now() + interval '30 days') returning id into v_deletion;
  end if;
  update public.compliance_requests set workspace_id = v_ws.id, status = 'processing' where id = v_request;
  update public.shop_lifecycle_events set workspace_id = v_ws.id, outcome = 'deletion_started' where id = v_event;
  return jsonb_build_object('outcome', case when v_existing then 'deletion_already_running' else 'deletion_started' end,
    'compliance_request_id', v_request, 'deletion_id', v_deletion, 'workspace_id', v_ws.id, 'shop_domain', v_domain);
end;
$$;

-- Customer compliance topics: recorded, and resolved immediately because
-- Omnitarget holds no customer-level records (SEC-09).
create or replace function public.record_customer_compliance(p_topic text, p_shopify_shop_id bigint, p_domain text, p_event_key text, p_triggered_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event bigint;
  v_request uuid;
begin
  if p_topic not in ('customers/redact', 'customers/data_request') then raise exception 'unsupported_compliance_topic'; end if;
  insert into public.shop_lifecycle_events (topic, event_key, shopify_shop_id, shop_domain, triggered_at, outcome)
  values (p_topic, p_event_key, p_shopify_shop_id, lower(btrim(coalesce(p_domain, ''))), p_triggered_at, 'no_customer_data_held')
  on conflict (topic, event_key) do nothing returning id into v_event;
  if v_event is null then return jsonb_build_object('outcome', 'duplicate'); end if;
  insert into public.compliance_requests (lifecycle_event_id, topic, shopify_shop_id, shop_domain, received_at, due_at, status, resolution, completed_at)
  values (v_event, p_topic, p_shopify_shop_id, lower(btrim(coalesce(p_domain, ''))), now(), now() + interval '30 days',
          'completed', 'no_customer_data_held', now())
  returning id into v_request;
  return jsonb_build_object('outcome', 'completed', 'compliance_request_id', v_request);
end;
$$;

-- Executes a deletion: Shopify-derived data first, then workspace content,
-- then verification. Only a verified deletion closes the workspace and
-- releases the binding. Never touches other workspaces or Clerk identities.
create or replace function public.process_workspace_deletion(p_deletion uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_deletion public.workspace_deletions%rowtype;
  v_ws public.workspaces%rowtype;
  v_shop uuid;
  v_domain text;
  v_remaining jsonb;
begin
  select * into v_deletion from public.workspace_deletions where id = p_deletion for update;
  if not found then raise exception 'deletion_not_found'; end if;
  if v_deletion.status = 'completed' then return jsonb_build_object('outcome', 'completed', 'workspace_id', v_deletion.workspace_id); end if;
  update public.workspace_deletions set attempts = attempts + 1, started_at = coalesce(started_at, now()) where id = p_deletion;

  select * into v_ws from public.workspaces where id = v_deletion.workspace_id for update;
  select s.id, s.myshopify_domain into v_shop, v_domain from public.shop_bindings b join public.shops s on s.id = b.shop_id
   where b.workspace_id = v_ws.id and b.released_at is null;

  begin
    if v_domain is not null then
      perform public.redact_shop_data(v_domain);
    end if;
    delete from public.campaign_brief_versions where campaign_id in (select id from public.campaigns where workspace_id = v_ws.id);
    delete from public.campaigns where workspace_id = v_ws.id;

    v_remaining := jsonb_build_object(
      'integration_rows_naming_shop', (select count(*) from public.user_integrations
         where v_domain is not null and v_domain in (public.normalize_shop_host(shop_domain), public.normalize_shop_host(shopify_store_url))),
      'workspace_campaigns', (select count(*) from public.campaigns where workspace_id = v_ws.id),
      'capi_events', (select count(*) from public.capi_events where v_domain is not null and shop_domain = v_domain),
      'webhook_deliveries', (select count(*) from public.webhook_deliveries where v_domain is not null and shop_domain = v_domain));
    if exists (select 1 from jsonb_each_text(v_remaining) where value::int > 0) then
      raise exception 'deletion_verification_failed';
    end if;
  exception when others then
    update public.workspace_deletions set status = 'failed', last_error = sqlerrm, verification = v_remaining where id = p_deletion;
    return jsonb_build_object('outcome', 'failed', 'error', sqlerrm, 'workspace_id', v_ws.id);
  end;

  update public.shop_bindings set released_at = now(), release_reason = 'deletion_completed'
   where workspace_id = v_ws.id and released_at is null;
  update public.workspaces set status = 'deleted', status_changed_at = now(), deleted_at = now() where id = v_ws.id;
  update public.workspace_deletions set status = 'completed', completed_at = now(), verification = v_remaining, last_error = null where id = p_deletion;
  update public.compliance_requests set status = 'completed', completed_at = now(), resolution = 'shop_data_deleted'
   where workspace_id = v_ws.id and status <> 'completed';
  perform public.log_workspace_event(v_ws.id, v_shop, 'deletion_verified', null, 'system', null, v_remaining);
  perform public.log_workspace_event(v_ws.id, v_shop, 'deleted', null, 'system', null, '{}'::jsonb);
  return jsonb_build_object('outcome', 'completed', 'workspace_id', v_ws.id, 'verification', v_remaining);
end;
$$;

-- shop/redact for a shop with no workspace: legacy data is redacted by domain
-- and the request completed once nothing naming the shop remains.
create or replace function public.process_unbound_shop_redact(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request public.compliance_requests%rowtype;
  v_remaining integer;
begin
  select * into v_request from public.compliance_requests where id = p_request and topic = 'shop/redact' for update;
  if not found then raise exception 'compliance_request_not_found'; end if;
  if v_request.status = 'completed' then return jsonb_build_object('outcome', 'completed'); end if;
  if v_request.workspace_id is not null then return jsonb_build_object('outcome', 'has_workspace'); end if;
  perform public.redact_shop_data(v_request.shop_domain);
  select count(*) into v_remaining from public.user_integrations
   where v_request.shop_domain in (public.normalize_shop_host(shop_domain), public.normalize_shop_host(shopify_store_url));
  if v_remaining > 0 then
    update public.compliance_requests set status = 'processing' where id = p_request;
    return jsonb_build_object('outcome', 'failed', 'remaining', v_remaining);
  end if;
  update public.compliance_requests set status = 'completed', completed_at = now(), resolution = 'legacy_shop_data_deleted' where id = p_request;
  return jsonb_build_object('outcome', 'completed');
end;
$$;

-- Ownership transfer: request, Shopify verification, owner approval, completion.
-- No path skips the owner's approval. The target workspace is optional: when
-- none is named, completion creates one for the requester.
create or replace function public.request_ownership_transfer(p_domain text, p_requester text, p_target_workspace uuid default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop uuid;
  v_from public.workspaces%rowtype;
  v_target public.workspaces%rowtype;
  v_id uuid;
begin
  if coalesce(btrim(p_requester), '') = '' then raise exception 'workspace_access_denied'; end if;
  select id into v_shop from public.shops where myshopify_domain = public.myshopify_domain_or_null(p_domain);
  select w.* into v_from from public.shop_bindings b join public.workspaces w on w.id = b.workspace_id
   where b.shop_id = v_shop and b.released_at is null;
  if not found then raise exception 'shop_not_bound'; end if;
  if v_from.owner_clerk_user_id = p_requester then raise exception 'already_owner'; end if;
  if v_from.status not in ('active', 'disconnected') then raise exception 'shop_not_transferable'; end if;
  if p_target_workspace is not null then
    select * into v_target from public.workspaces where id = p_target_workspace;
    if not found or v_target.owner_clerk_user_id <> p_requester then raise exception 'workspace_access_denied'; end if;
    if v_target.status <> 'active' or exists (select 1 from public.shop_bindings where workspace_id = v_target.id and released_at is null) then
      raise exception 'target_workspace_ineligible';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:transfer:' || v_shop::text, 0));
  update public.ownership_transfers set status = 'expired', closed_at = now()
   where shop_id = v_shop and status in ('requested', 'verified', 'approved') and expires_at < now();
  if exists (select 1 from public.ownership_transfers where shop_id = v_shop and status in ('requested', 'verified', 'approved')) then
    raise exception 'transfer_already_open';
  end if;
  insert into public.ownership_transfers (shop_id, from_workspace_id, to_workspace_id, requested_by_clerk_user_id, reason)
  values (v_shop, v_from.id, p_target_workspace, p_requester, p_reason) returning id into v_id;
  perform public.log_workspace_event(v_from.id, v_shop, 'transfer_requested', p_requester, 'user', null,
    jsonb_build_object('transfer_id', v_id, 'to_workspace_id', p_target_workspace));
  return jsonb_build_object('outcome', 'requested', 'transfer_id', v_id);
end;
$$;

-- Verification is a Shopify-signed OAuth callback for the shop, without a code
-- exchange: exchanging would retire the current owner's token before approval.
create or replace function public.verify_ownership_transfer(p_transfer uuid, p_requester text, p_domain text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t public.ownership_transfers%rowtype;
begin
  select * into v_t from public.ownership_transfers where id = p_transfer for update;
  if not found or v_t.requested_by_clerk_user_id <> p_requester then raise exception 'transfer_access_denied'; end if;
  if v_t.status <> 'requested' or v_t.expires_at < now() then raise exception 'transfer_not_verifiable'; end if;
  if not exists (select 1 from public.shops where id = v_t.shop_id and myshopify_domain = public.myshopify_domain_or_null(p_domain)) then
    raise exception 'transfer_shop_mismatch';
  end if;
  update public.ownership_transfers set status = 'verified', shopify_verified_at = now() where id = p_transfer;
  perform public.log_workspace_event(v_t.from_workspace_id, v_t.shop_id, 'transfer_verified', p_requester, 'oauth', null, jsonb_build_object('transfer_id', p_transfer));
  return jsonb_build_object('outcome', 'verified');
end;
$$;

create or replace function public.approve_ownership_transfer(p_transfer uuid, p_approver text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t public.ownership_transfers%rowtype;
begin
  select * into v_t from public.ownership_transfers where id = p_transfer for update;
  if not found then raise exception 'transfer_not_found'; end if;
  if not exists (select 1 from public.workspaces w join public.shop_bindings b on b.workspace_id = w.id and b.released_at is null
                  where w.id = v_t.from_workspace_id and b.shop_id = v_t.shop_id and w.owner_clerk_user_id = p_approver) then
    raise exception 'transfer_access_denied';
  end if;
  if v_t.status <> 'verified' or v_t.expires_at < now() then raise exception 'transfer_not_approvable'; end if;
  update public.ownership_transfers set status = 'approved', approved_at = now(), approved_by_clerk_user_id = p_approver where id = p_transfer;
  perform public.log_workspace_event(v_t.from_workspace_id, v_t.shop_id, 'transfer_approved', p_approver, 'user', null, jsonb_build_object('transfer_id', p_transfer));
  return jsonb_build_object('outcome', 'approved');
end;
$$;

-- Completion is the new owner's fresh, authenticated installation. Credits,
-- campaigns and billing history stay with the original workspace.
create or replace function public.complete_ownership_transfer(p_transfer uuid, p_requester text, p_shopify_shop_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t public.ownership_transfers%rowtype;
  v_to public.workspaces%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:shop:' || p_shopify_shop_id::text, 0));
  select * into v_t from public.ownership_transfers where id = p_transfer for update;
  if not found or v_t.requested_by_clerk_user_id <> p_requester then raise exception 'transfer_access_denied'; end if;
  if v_t.status <> 'approved' or v_t.expires_at < now() then raise exception 'transfer_not_approved'; end if;
  if not exists (select 1 from public.shops where id = v_t.shop_id and shopify_shop_id = p_shopify_shop_id) then raise exception 'transfer_shop_mismatch'; end if;

  if v_t.to_workspace_id is null then
    insert into public.workspaces (owner_clerk_user_id) values (p_requester) returning * into v_to;
    perform public.log_workspace_event(v_to.id, v_t.shop_id, 'provisioned', p_requester, 'oauth', null, jsonb_build_object('transfer_id', p_transfer));
    update public.ownership_transfers set to_workspace_id = v_to.id where id = p_transfer;
  else
    select * into v_to from public.workspaces where id = v_t.to_workspace_id for update;
    if v_to.owner_clerk_user_id <> p_requester or v_to.status <> 'active'
       or exists (select 1 from public.shop_bindings where workspace_id = v_to.id and released_at is null) then
      raise exception 'target_workspace_ineligible';
    end if;
  end if;

  update public.shop_bindings set released_at = now(), release_reason = 'ownership_transferred', transfer_id = p_transfer
   where shop_id = v_t.shop_id and workspace_id = v_t.from_workspace_id and released_at is null;
  if not found then raise exception 'transfer_binding_changed'; end if;
  insert into public.shop_bindings (shop_id, workspace_id, bound_by_clerk_user_id, transfer_id)
  values (v_t.shop_id, v_to.id, p_requester, p_transfer);
  update public.workspaces set status = 'active', status_changed_at = now(), last_connected_at = now() where id = v_to.id;
  update public.ownership_transfers set status = 'completed', completed_at = now(), closed_at = now() where id = p_transfer;
  perform public.log_workspace_event(v_t.from_workspace_id, v_t.shop_id, 'transfer_completed', p_requester, 'oauth', null, jsonb_build_object('transfer_id', p_transfer, 'role', 'released'));
  perform public.log_workspace_event(v_to.id, v_t.shop_id, 'transfer_completed', p_requester, 'oauth', null, jsonb_build_object('transfer_id', p_transfer, 'role', 'received'));
  return jsonb_build_object('outcome', 'completed', 'workspace_id', v_to.id, 'previous_workspace_id', v_t.from_workspace_id);
end;
$$;

create or replace function public.cancel_ownership_transfer(p_transfer uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t public.ownership_transfers%rowtype;
begin
  select * into v_t from public.ownership_transfers where id = p_transfer for update;
  if not found then raise exception 'transfer_not_found'; end if;
  if v_t.requested_by_clerk_user_id <> p_actor and not exists (
       select 1 from public.workspaces where id = v_t.from_workspace_id and owner_clerk_user_id = p_actor) then
    raise exception 'transfer_access_denied';
  end if;
  if v_t.status not in ('requested', 'verified', 'approved') then return jsonb_build_object('outcome', v_t.status); end if;
  update public.ownership_transfers set status = 'cancelled', closed_at = now() where id = p_transfer;
  perform public.log_workspace_event(v_t.from_workspace_id, v_t.shop_id, 'transfer_cancelled', p_actor, 'user', null, jsonb_build_object('transfer_id', p_transfer));
  return jsonb_build_object('outcome', 'cancelled');
end;
$$;

-- Legacy accounts: one workspace per legacy row, and a claim on its domain.
-- Several claims on one domain are contested; an invalid domain is unresolved.
create or replace function public.register_legacy_account(p_legacy_row uuid, p_clerk_user text, p_domain text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(p_domain);
  v_claim public.legacy_shop_claims%rowtype;
  v_ws uuid;
  v_status text;
begin
  if p_legacy_row is null or coalesce(btrim(p_clerk_user), '') = '' then raise exception 'legacy_row_and_user_required'; end if;
  if v_domain is not null then perform pg_advisory_xact_lock(hashtextextended('omnitarget:domain:' || v_domain, 0)); end if;
  select * into v_claim from public.legacy_shop_claims where legacy_source = 'user_integrations' and legacy_row_id = p_legacy_row;
  if found then return jsonb_build_object('outcome', 'existing', 'workspace_id', v_claim.workspace_id, 'claim_id', v_claim.id, 'status', v_claim.status); end if;

  select id into v_ws from public.workspaces where legacy_user_integration_id = p_legacy_row;
  if not found then
    insert into public.workspaces (owner_clerk_user_id, legacy_user_integration_id) values (p_clerk_user, p_legacy_row) returning id into v_ws;
    perform public.log_workspace_event(v_ws, null, 'provisioned', p_clerk_user, 'migration', null, jsonb_build_object('legacy_row_id', p_legacy_row));
  end if;

  if v_domain is null then
    v_status := 'unresolved';
  elsif exists (select 1 from public.legacy_shop_claims where claimed_domain = v_domain and status in ('provisional', 'contested')) then
    update public.legacy_shop_claims set status = 'contested' where claimed_domain = v_domain and status = 'provisional';
    v_status := 'contested';
  else
    v_status := 'provisional';
  end if;
  insert into public.legacy_shop_claims (legacy_row_id, clerk_user_id, claimed_domain, workspace_id, status, review_note)
  values (p_legacy_row, p_clerk_user, coalesce(v_domain, lower(btrim(coalesce(p_domain, '')))), v_ws, v_status,
          case when v_domain is null then 'missing_or_invalid_domain' end)
  returning * into v_claim;
  perform public.log_workspace_event(v_ws, null, 'legacy_claim_registered', p_clerk_user, 'migration', null,
    jsonb_build_object('claim_id', v_claim.id, 'status', v_status));
  return jsonb_build_object('outcome', 'registered', 'workspace_id', v_ws, 'claim_id', v_claim.id, 'status', v_status);
end;
$$;

-- Review of a contested domain: keep one claim as provisional (still confirmed
-- only by that account's authenticated connection) or reject them all.
create or replace function public.review_legacy_claims(p_domain text, p_winning_claim uuid, p_reviewer text, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(p_domain);
begin
  if v_domain is null or coalesce(btrim(p_reviewer), '') = '' or coalesce(btrim(p_note), '') = '' then raise exception 'review_details_required'; end if;
  if p_winning_claim is not null and not exists (
       select 1 from public.legacy_shop_claims where id = p_winning_claim and claimed_domain = v_domain and status = 'contested') then
    raise exception 'winning_claim_invalid';
  end if;
  update public.legacy_shop_claims
     set status = case when id = p_winning_claim then 'provisional' else 'rejected' end, reviewed_by = p_reviewer, review_note = p_note
   where claimed_domain = v_domain and status = 'contested';
  return jsonb_build_object('outcome', 'reviewed');
end;
$$;

-- Authorisation helpers. The service role bypasses RLS, so every workspace
-- read goes through these checks against the authenticated actor.
create or replace function public.workspace_for_actor(p_workspace uuid, p_actor text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ws public.workspaces%rowtype;
  v_domain text;
begin
  select * into v_ws from public.workspaces where id = p_workspace;
  if not found or v_ws.owner_clerk_user_id <> p_actor or v_ws.status in ('deletion_processing', 'deleted') then
    raise exception 'workspace_access_denied';
  end if;
  select s.myshopify_domain into v_domain from public.shop_bindings b join public.shops s on s.id = b.shop_id
   where b.workspace_id = v_ws.id and b.released_at is null;
  return jsonb_build_object('workspace_id', v_ws.id, 'status', v_ws.status, 'shop_domain', v_domain, 'created_at', v_ws.created_at);
end;
$$;

create or replace function public.list_workspaces(p_actor text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'status', w.status, 'shop_domain', s.myshopify_domain, 'created_at', w.created_at)
                            order by w.created_at), '[]'::jsonb)
    from public.workspaces w
    left join public.shop_bindings b on b.workspace_id = w.id and b.released_at is null
    left join public.shops s on s.id = b.shop_id
   where w.owner_clerk_user_id = p_actor and w.status not in ('deletion_processing', 'deleted');
$$;

create or replace function public.workspace_credit_balance(p_workspace uuid, p_actor text)
returns integer language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.workspace_for_actor(p_workspace, p_actor);
  return (select balance from public.credit_accounts where workspace_id = p_workspace);
end;
$$;

-- Campaigns are visible only to their creator, inside the creator's workspace.
create or replace function public.campaign_for_actor(p_campaign uuid, p_workspace uuid, p_actor text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_row jsonb;
begin
  perform public.workspace_for_actor(p_workspace, p_actor);
  select jsonb_build_object('id', id, 'product_name', product_name, 'status', status, 'created_at', created_at) into v_row
    from public.campaigns where id = p_campaign and workspace_id = p_workspace and clerk_user_id = p_actor;
  if v_row is null then raise exception 'campaign_not_found'; end if;
  return v_row;
end;
$$;

create or replace function public.workspace_can_operate(p_workspace uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.workspaces w
      join public.shop_bindings b on b.workspace_id = w.id and b.released_at is null
     where w.id = p_workspace and w.status = 'active'
       and not exists (select 1 from public.workspace_deletions d where d.workspace_id = w.id and d.status <> 'completed'));
$$;

-- For legacy code paths keyed by domain. A shop not yet modelled keeps the
-- legacy behaviour; a modelled shop needs an active, bound workspace.
create or replace function public.shop_operations_allowed(p_domain text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when s.id is null then true
    else exists (select 1 from public.shop_bindings b where b.shop_id = s.id and b.released_at is null
                    and public.workspace_can_operate(b.workspace_id))
  end
  from (select (select id from public.shops where myshopify_domain = public.myshopify_domain_or_null(p_domain)) as id) s;
$$;

-- Access: client roles reach nothing. The application reads these tables and
-- changes them only through the functions above.
alter table public.workspaces enable row level security;
alter table public.credit_accounts enable row level security;
alter table public.shops enable row level security;
alter table public.shop_bindings enable row level security;
alter table public.workspace_events enable row level security;
alter table public.shop_lifecycle_events enable row level security;
alter table public.compliance_requests enable row level security;
alter table public.workspace_deletions enable row level security;
alter table public.ownership_transfers enable row level security;
alter table public.legacy_shop_claims enable row level security;

revoke all on table public.workspaces, public.credit_accounts, public.shops, public.shop_bindings, public.workspace_events,
  public.shop_lifecycle_events, public.compliance_requests, public.workspace_deletions, public.ownership_transfers,
  public.legacy_shop_claims from public, anon, authenticated, service_role;
grant select on table public.workspaces, public.credit_accounts, public.shops, public.shop_bindings, public.workspace_events,
  public.shop_lifecycle_events, public.compliance_requests, public.workspace_deletions, public.ownership_transfers,
  public.legacy_shop_claims to service_role;

revoke all on function
  public.myshopify_domain_or_null(text), public.reject_row_mutation(), public.create_credit_account(),
  public.log_workspace_event(uuid, uuid, text, text, text, timestamptz, jsonb), public.shop_has_open_redaction(bigint, text),
  public.find_shop(bigint, text), public.shop_connection_preflight(text, text),
  public.bind_shop_for_install(bigint, text, text, uuid, text), public.disconnect_workspace(uuid, text),
  public.begin_uninstall(bigint, text, text, timestamptz), public.record_shop_redact(bigint, text, text, timestamptz),
  public.record_customer_compliance(text, bigint, text, text, timestamptz), public.process_workspace_deletion(uuid),
  public.process_unbound_shop_redact(uuid), public.request_ownership_transfer(text, text, uuid, text),
  public.verify_ownership_transfer(uuid, text, text), public.approve_ownership_transfer(uuid, text),
  public.complete_ownership_transfer(uuid, text, bigint), public.cancel_ownership_transfer(uuid, text),
  public.register_legacy_account(uuid, text, text), public.review_legacy_claims(text, uuid, text, text),
  public.workspace_for_actor(uuid, text), public.list_workspaces(text), public.workspace_credit_balance(uuid, text),
  public.campaign_for_actor(uuid, uuid, text), public.workspace_can_operate(uuid), public.shop_operations_allowed(text)
from public, anon, authenticated, service_role;

grant execute on function
  public.myshopify_domain_or_null(text), public.shop_connection_preflight(text, text),
  public.bind_shop_for_install(bigint, text, text, uuid, text), public.disconnect_workspace(uuid, text),
  public.begin_uninstall(bigint, text, text, timestamptz), public.record_shop_redact(bigint, text, text, timestamptz),
  public.record_customer_compliance(text, bigint, text, text, timestamptz), public.process_workspace_deletion(uuid),
  public.process_unbound_shop_redact(uuid), public.request_ownership_transfer(text, text, uuid, text),
  public.verify_ownership_transfer(uuid, text, text), public.approve_ownership_transfer(uuid, text),
  public.complete_ownership_transfer(uuid, text, bigint), public.cancel_ownership_transfer(uuid, text),
  public.register_legacy_account(uuid, text, text), public.review_legacy_claims(text, uuid, text, text),
  public.workspace_for_actor(uuid, text), public.list_workspaces(text), public.workspace_credit_balance(uuid, text),
  public.campaign_for_actor(uuid, uuid, text), public.workspace_can_operate(uuid), public.shop_operations_allowed(text)
to service_role;
