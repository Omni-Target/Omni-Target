-- 0020: encrypted credentials (Phase 1, task 4).
--
-- The database stores ciphertext only. Encryption (AES-256-GCM) happens in
-- the application with a key held outside the database; no key reaches SQL
-- and nothing here can decrypt. Each value is bound by authenticated data to
-- its purpose and owner (Shopify shop id, or workspace and kind), so a
-- ciphertext moved to another shop, workspace or kind fails to decrypt.
--
--   * shop_credentials: one current Shopify credential per shop, written in
--     the same transaction as the binding (under the install lease) and
--     replaced on refresh only by the holder of the shop's refresh lease and
--     only from the version it read.
--   * workspace_meta_credentials / workspace_meta_connections: Meta belongs to
--     a workspace, never to a Clerk user across workspaces. Page lists are
--     kept without tokens.
--   * A workspace leaving 'active' loses its Shopify credential; one being
--     deleted loses its Meta credentials too.
--
-- Legacy plaintext columns in user_integrations are neither written nor
-- cleared here: removal waits for the scheduled backup and restore gate.

create table public.shop_credentials (
  shop_id             uuid primary key references public.shops (id),
  workspace_id        uuid not null references public.workspaces (id),
  key_version         integer not null check (key_version > 0),
  access_ciphertext   bytea not null,
  access_nonce        bytea not null check (octet_length(access_nonce) = 12),
  access_tag          bytea not null check (octet_length(access_tag) = 16),
  refresh_ciphertext  bytea,
  refresh_nonce       bytea check (octet_length(refresh_nonce) = 12),
  refresh_tag         bytea check (octet_length(refresh_tag) = 16),
  access_expires_at   timestamptz,
  refresh_expires_at  timestamptz,
  scopes              text,
  status              text not null default 'active' check (status in ('active', 'refresh_failed')),
  version             bigint not null default 1,
  issued_at           timestamptz not null default now(),
  refreshed_at        timestamptz,
  updated_at          timestamptz not null default now(),
  last_error          text,
  constraint shop_credentials_refresh_complete check (
    (refresh_ciphertext is null) = (refresh_nonce is null) and (refresh_nonce is null) = (refresh_tag is null)
  )
);
create index shop_credentials_workspace_idx on public.shop_credentials (workspace_id);
create index shop_credentials_key_version_idx on public.shop_credentials (key_version);

create table public.workspace_meta_credentials (
  workspace_id  uuid not null references public.workspaces (id),
  kind          text not null check (kind in ('user', 'page')),
  subject_id    text,
  key_version   integer not null check (key_version > 0),
  ciphertext    bytea not null,
  nonce         bytea not null check (octet_length(nonce) = 12),
  tag           bytea not null check (octet_length(tag) = 16),
  expires_at    timestamptz,
  version       bigint not null default 1,
  issued_at     timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, kind)
);
create index workspace_meta_credentials_key_version_idx on public.workspace_meta_credentials (key_version);

create table public.workspace_meta_connections (
  workspace_id   uuid primary key references public.workspaces (id),
  ad_accounts    jsonb not null default '[]'::jsonb,
  pages          jsonb not null default '[]'::jsonb,
  ad_account_id  text,
  pixel_id       text,
  business_id    text,
  page_id        text,
  page_name      text,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Listings never carry tokens; the selected page's token is encrypted above.
  constraint workspace_meta_connections_no_tokens check (
    position('access_token' in ad_accounts::text) = 0 and position('access_token' in pages::text) = 0
  )
);

-- ── Internal helpers (not granted to the application) ──────────────────────

create or replace function public.sealed_part(p_credential jsonb, p_part text)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select case when p_credential -> p_part is null or jsonb_typeof(p_credential -> p_part) = 'null' then null else p_credential -> p_part end;
$$;

create or replace function public.store_shop_credential(p_shop uuid, p_workspace uuid, p_credential jsonb)
returns bigint language plpgsql set search_path = public, pg_temp as $$
declare
  v_access jsonb := public.sealed_part(p_credential, 'access');
  v_refresh jsonb := public.sealed_part(p_credential, 'refresh');
  v_version bigint;
begin
  if v_access is null or (p_credential ->> 'key_version') is null then raise exception 'credential_incomplete'; end if;
  insert into public.shop_credentials as c (
    shop_id, workspace_id, key_version, access_ciphertext, access_nonce, access_tag,
    refresh_ciphertext, refresh_nonce, refresh_tag, access_expires_at, refresh_expires_at, scopes
  ) values (
    p_shop, p_workspace, (p_credential ->> 'key_version')::int,
    decode(v_access ->> 'ciphertext', 'base64'), decode(v_access ->> 'nonce', 'base64'), decode(v_access ->> 'tag', 'base64'),
    decode(v_refresh ->> 'ciphertext', 'base64'), decode(v_refresh ->> 'nonce', 'base64'), decode(v_refresh ->> 'tag', 'base64'),
    (p_credential ->> 'access_expires_at')::timestamptz, (p_credential ->> 'refresh_expires_at')::timestamptz, p_credential ->> 'scopes'
  )
  on conflict (shop_id) do update set
    workspace_id = excluded.workspace_id, key_version = excluded.key_version,
    access_ciphertext = excluded.access_ciphertext, access_nonce = excluded.access_nonce, access_tag = excluded.access_tag,
    refresh_ciphertext = excluded.refresh_ciphertext, refresh_nonce = excluded.refresh_nonce, refresh_tag = excluded.refresh_tag,
    access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes,
    status = 'active', version = c.version + 1, issued_at = now(), refreshed_at = null, updated_at = now(), last_error = null
  returning version into v_version;
  return v_version;
end;
$$;

create or replace function public.shop_credential_payload(p_cred public.shop_credentials, p_shop public.shops)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'outcome', 'ok',
    'shop_id', p_shop.id, 'shopify_shop_id', p_shop.shopify_shop_id::text, 'shop_domain', p_shop.myshopify_domain,
    'workspace_id', p_cred.workspace_id, 'version', p_cred.version, 'key_version', p_cred.key_version, 'status', p_cred.status,
    'access', jsonb_build_object('ciphertext', encode(p_cred.access_ciphertext, 'base64'), 'nonce', encode(p_cred.access_nonce, 'base64'), 'tag', encode(p_cred.access_tag, 'base64')),
    'refresh', case when p_cred.refresh_ciphertext is null then null else
      jsonb_build_object('ciphertext', encode(p_cred.refresh_ciphertext, 'base64'), 'nonce', encode(p_cred.refresh_nonce, 'base64'), 'tag', encode(p_cred.refresh_tag, 'base64')) end,
    'access_expires_at', p_cred.access_expires_at, 'refresh_expires_at', p_cred.refresh_expires_at, 'scopes', p_cred.scopes);
$$;

create or replace function public.meta_sealed(p_cred public.workspace_meta_credentials)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select case when p_cred.workspace_id is null then null else jsonb_build_object(
    'key_version', p_cred.key_version, 'subject_id', p_cred.subject_id, 'expires_at', p_cred.expires_at, 'version', p_cred.version,
    'ciphertext', encode(p_cred.ciphertext, 'base64'), 'nonce', encode(p_cred.nonce, 'base64'), 'tag', encode(p_cred.tag, 'base64')) end;
$$;

create or replace function public.store_meta_credential(p_workspace uuid, p_kind text, p_credential jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if p_credential is null then
    delete from public.workspace_meta_credentials where workspace_id = p_workspace and kind = p_kind;
    return;
  end if;
  insert into public.workspace_meta_credentials as c (workspace_id, kind, subject_id, key_version, ciphertext, nonce, tag, expires_at)
  values (p_workspace, p_kind, p_credential ->> 'subject_id', (p_credential ->> 'key_version')::int,
          decode(p_credential ->> 'ciphertext', 'base64'), decode(p_credential ->> 'nonce', 'base64'), decode(p_credential ->> 'tag', 'base64'),
          (p_credential ->> 'expires_at')::timestamptz)
  on conflict (workspace_id, kind) do update set
    subject_id = excluded.subject_id, key_version = excluded.key_version, ciphertext = excluded.ciphertext, nonce = excluded.nonce,
    tag = excluded.tag, expires_at = excluded.expires_at, version = c.version + 1, issued_at = now(), updated_at = now();
end;
$$;

-- A workspace leaving 'active' (disconnect, uninstall, deletion) loses its
-- Shopify credential; one being deleted loses its Meta credentials too. Only
-- the workspace's own rows are touched, so another workspace's credential for
-- a shop it now holds (after a transfer) is never affected.
create or replace function public.clear_workspace_credentials()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = 'active' and new.status <> 'active' then
    delete from public.shop_credentials where workspace_id = new.id;
    if found then
      perform public.log_workspace_event(new.id, null, 'credential_cleared', null, 'system', null, jsonb_build_object('reason', new.status));
    end if;
  end if;
  if new.status in ('deletion_processing', 'deleted') and old.status not in ('deletion_processing', 'deleted') then
    delete from public.workspace_meta_credentials where workspace_id = new.id;
    delete from public.workspace_meta_connections where workspace_id = new.id;
  end if;
  return new;
end;
$$;
create trigger workspaces_clear_credentials after update of status on public.workspaces
  for each row when (old.status is distinct from new.status) execute function public.clear_workspace_credentials();

-- ── Installation: binding and credential in one transaction ────────────────

create or replace function public.commit_shop_install_under_lease(
  p_lease_domain text, p_holder uuid, p_shopify_shop_id bigint, p_domain text, p_actor text,
  p_selected_workspace uuid, p_shop_name text, p_transfer uuid, p_credential jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result jsonb;
  v_shop uuid;
  v_workspace uuid;
begin
  if p_credential is null then raise exception 'credential_required'; end if;
  if p_transfer is null then
    v_result := public.bind_shop_under_lease(p_lease_domain, p_holder, p_shopify_shop_id, p_domain, p_actor, p_selected_workspace, p_shop_name);
  else
    v_result := public.complete_transfer_under_lease(p_lease_domain, p_holder, p_transfer, p_actor, p_shopify_shop_id);
  end if;
  if (v_result ->> 'outcome') not in ('bound_new_workspace', 'bound_existing_workspace', 'already_bound', 'reconnected', 'restored', 'completed') then
    return v_result;
  end if;
  select id into v_shop from public.shops where shopify_shop_id = p_shopify_shop_id;
  v_workspace := (v_result ->> 'workspace_id')::uuid;
  perform public.store_shop_credential(v_shop, v_workspace, p_credential);
  perform public.log_workspace_event(v_workspace, v_shop, 'credential_issued', p_actor, 'oauth', null,
    jsonb_build_object('key_version', (p_credential ->> 'key_version')::int));
  return v_result;
end;
$$;

-- ── Shopify credential access (only for a workspace allowed to operate) ────

create or replace function public.shop_credential_for_workspace(p_workspace uuid, p_actor text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ws public.workspaces%rowtype;
  v_shop public.shops%rowtype;
  v_cred public.shop_credentials%rowtype;
begin
  select * into v_ws from public.workspaces where id = p_workspace;
  if not found or v_ws.owner_clerk_user_id is distinct from p_actor then
    return jsonb_build_object('outcome', 'access_denied');
  end if;
  if not public.workspace_can_operate(p_workspace) then
    return jsonb_build_object('outcome', 'workspace_inactive', 'status', v_ws.status);
  end if;
  select s.* into v_shop from public.shop_bindings b join public.shops s on s.id = b.shop_id
   where b.workspace_id = p_workspace and b.released_at is null;
  select * into v_cred from public.shop_credentials where shop_id = v_shop.id and workspace_id = p_workspace;
  if not found then return jsonb_build_object('outcome', 'not_connected', 'shop_domain', v_shop.myshopify_domain); end if;
  return public.shop_credential_payload(v_cred, v_shop);
end;
$$;

-- System context (webhooks, scheduled jobs): by shop, same lifecycle rules.
create or replace function public.shop_credential_for_shop(p_domain text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_shop public.shops%rowtype;
  v_workspace uuid;
  v_cred public.shop_credentials%rowtype;
begin
  select * into v_shop from public.shops where myshopify_domain = public.myshopify_domain_or_null(p_domain);
  if not found then return jsonb_build_object('outcome', 'not_modelled'); end if;
  select workspace_id into v_workspace from public.shop_bindings where shop_id = v_shop.id and released_at is null;
  if v_workspace is null or not public.workspace_can_operate(v_workspace) then
    return jsonb_build_object('outcome', 'workspace_inactive');
  end if;
  select * into v_cred from public.shop_credentials where shop_id = v_shop.id and workspace_id = v_workspace;
  if not found then return jsonb_build_object('outcome', 'not_connected', 'shop_domain', v_shop.myshopify_domain); end if;
  return public.shop_credential_payload(v_cred, v_shop);
end;
$$;

-- Refresh: only the holder of the shop's refresh lease may store, and only
-- over the version it refreshed from. A stale worker gets 'stale'.
create or replace function public.store_refreshed_shop_credential(p_shop uuid, p_holder uuid, p_expected_version bigint, p_credential jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_access jsonb := public.sealed_part(p_credential, 'access');
  v_refresh jsonb := public.sealed_part(p_credential, 'refresh');
  v_version bigint;
  v_workspace uuid;
begin
  if v_access is null then raise exception 'credential_incomplete'; end if;
  if not public.hold_shop_lease('refresh:' || p_shop::text, p_holder) then
    return jsonb_build_object('outcome', 'lease_lost');
  end if;
  update public.shop_credentials set
    key_version = (p_credential ->> 'key_version')::int,
    access_ciphertext = decode(v_access ->> 'ciphertext', 'base64'), access_nonce = decode(v_access ->> 'nonce', 'base64'), access_tag = decode(v_access ->> 'tag', 'base64'),
    refresh_ciphertext = decode(v_refresh ->> 'ciphertext', 'base64'), refresh_nonce = decode(v_refresh ->> 'nonce', 'base64'), refresh_tag = decode(v_refresh ->> 'tag', 'base64'),
    access_expires_at = (p_credential ->> 'access_expires_at')::timestamptz, refresh_expires_at = (p_credential ->> 'refresh_expires_at')::timestamptz,
    scopes = coalesce(p_credential ->> 'scopes', scopes), status = 'active', version = version + 1,
    refreshed_at = now(), updated_at = now(), last_error = null
   where shop_id = p_shop and version = p_expected_version and public.workspace_can_operate(workspace_id)
  returning version, workspace_id into v_version, v_workspace;
  if not found then return jsonb_build_object('outcome', 'stale'); end if;
  perform public.log_workspace_event(v_workspace, p_shop, 'credential_refreshed', null, 'system', null,
    jsonb_build_object('version', v_version, 'key_version', (p_credential ->> 'key_version')::int));
  return jsonb_build_object('outcome', 'stored', 'version', v_version);
end;
$$;

-- A failed refresh never deletes a credential. A definitively rejected
-- refresh token marks it 'refresh_failed' (reconnect needed); a transient
-- failure only records its classification.
create or replace function public.record_shop_refresh_failure(p_shop uuid, p_expected_version bigint, p_dead boolean, p_error text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
begin
  update public.shop_credentials
     set status = case when p_dead then 'refresh_failed' else status end, last_error = left(p_error, 120), updated_at = now()
   where shop_id = p_shop and version = p_expected_version
  returning workspace_id into v_workspace;
  if not found then return false; end if;
  if p_dead then
    perform public.log_workspace_event(v_workspace, p_shop, 'credential_refresh_failed', null, 'system', null,
      jsonb_build_object('error', left(p_error, 120)));
  end if;
  return true;
end;
$$;

-- Key rotation: re-encrypts under a newer key, never over a newer version.
create or replace function public.reseal_shop_credential(p_shop uuid, p_expected_version bigint, p_credential jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_access jsonb := public.sealed_part(p_credential, 'access');
  v_refresh jsonb := public.sealed_part(p_credential, 'refresh');
begin
  update public.shop_credentials set
    key_version = (p_credential ->> 'key_version')::int,
    access_ciphertext = decode(v_access ->> 'ciphertext', 'base64'), access_nonce = decode(v_access ->> 'nonce', 'base64'), access_tag = decode(v_access ->> 'tag', 'base64'),
    refresh_ciphertext = decode(v_refresh ->> 'ciphertext', 'base64'), refresh_nonce = decode(v_refresh ->> 'nonce', 'base64'), refresh_tag = decode(v_refresh ->> 'tag', 'base64'),
    version = version + 1, updated_at = now()
   where shop_id = p_shop and version = p_expected_version and key_version < (p_credential ->> 'key_version')::int;
  return found;
end;
$$;

create or replace function public.credentials_below_key_version(p_version integer, p_limit integer default 100)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'shop', coalesce((select jsonb_agg(public.shop_credential_payload(c, s))
        from (select * from public.shop_credentials where key_version < p_version order by updated_at limit p_limit) c
        join public.shops s on s.id = c.shop_id), '[]'::jsonb),
    'meta', coalesce((select jsonb_agg(jsonb_build_object('workspace_id', m.workspace_id, 'kind', m.kind) || public.meta_sealed(m))
        from (select * from public.workspace_meta_credentials where key_version < p_version order by updated_at limit p_limit) m), '[]'::jsonb));
$$;

create or replace function public.reseal_meta_credential(p_workspace uuid, p_kind text, p_expected_version bigint, p_credential jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.workspace_meta_credentials set
    key_version = (p_credential ->> 'key_version')::int, ciphertext = decode(p_credential ->> 'ciphertext', 'base64'),
    nonce = decode(p_credential ->> 'nonce', 'base64'), tag = decode(p_credential ->> 'tag', 'base64'),
    version = version + 1, updated_at = now()
   where workspace_id = p_workspace and kind = p_kind and version = p_expected_version
     and key_version < (p_credential ->> 'key_version')::int;
  return found;
end;
$$;

-- ── Meta: per workspace, owner only ────────────────────────────────────────

create or replace function public.meta_workspace_writable(p_workspace uuid, p_actor text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from public.workspaces where id = p_workspace and owner_clerk_user_id = p_actor
                   and status not in ('deletion_processing', 'deleted'));
$$;

create or replace function public.store_meta_connection(
  p_workspace uuid, p_actor text, p_user_credential jsonb, p_page_credential jsonb, p_connection jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.meta_workspace_writable(p_workspace, p_actor) then raise exception 'workspace_access_denied'; end if;
  if p_user_credential is null then raise exception 'credential_required'; end if;
  perform public.store_meta_credential(p_workspace, 'user', p_user_credential);
  perform public.store_meta_credential(p_workspace, 'page', p_page_credential);
  insert into public.workspace_meta_connections as m (workspace_id, ad_accounts, pages, ad_account_id, pixel_id, business_id, page_id, page_name)
  values (p_workspace, coalesce(p_connection -> 'ad_accounts', '[]'::jsonb), coalesce(p_connection -> 'pages', '[]'::jsonb),
          p_connection ->> 'ad_account_id', p_connection ->> 'pixel_id', p_connection ->> 'business_id',
          p_connection ->> 'page_id', p_connection ->> 'page_name')
  on conflict (workspace_id) do update set
    ad_accounts = excluded.ad_accounts, pages = excluded.pages, ad_account_id = excluded.ad_account_id, pixel_id = excluded.pixel_id,
    business_id = excluded.business_id, page_id = excluded.page_id, page_name = excluded.page_name,
    connected_at = now(), updated_at = now();
  perform public.log_workspace_event(p_workspace, null, 'meta_connected', p_actor, 'oauth', null,
    jsonb_build_object('key_version', (p_user_credential ->> 'key_version')::int));
  return jsonb_build_object('outcome', 'stored');
end;
$$;

create or replace function public.select_meta_ad_account(p_workspace uuid, p_actor text, p_ad_account_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_conn public.workspace_meta_connections%rowtype;
begin
  if not public.meta_workspace_writable(p_workspace, p_actor) then raise exception 'workspace_access_denied'; end if;
  select * into v_conn from public.workspace_meta_connections where workspace_id = p_workspace for update;
  if not found or not exists (select 1 from jsonb_array_elements(v_conn.ad_accounts) a where a ->> 'id' = p_ad_account_id) then
    raise exception 'meta_asset_not_found';
  end if;
  update public.workspace_meta_connections set ad_account_id = p_ad_account_id, updated_at = now() where workspace_id = p_workspace;
  return jsonb_build_object('outcome', 'selected');
end;
$$;

create or replace function public.select_meta_page(p_workspace uuid, p_actor text, p_page_id text, p_page_credential jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_page jsonb;
begin
  if not public.meta_workspace_writable(p_workspace, p_actor) then raise exception 'workspace_access_denied'; end if;
  select p into v_page from public.workspace_meta_connections c, jsonb_array_elements(c.pages) p
   where c.workspace_id = p_workspace and p ->> 'id' = p_page_id;
  if v_page is null then raise exception 'meta_asset_not_found'; end if;
  perform public.store_meta_credential(p_workspace, 'page', p_page_credential);
  update public.workspace_meta_connections set page_id = p_page_id, page_name = v_page ->> 'name', updated_at = now()
   where workspace_id = p_workspace;
  return jsonb_build_object('outcome', 'selected', 'page_name', v_page ->> 'name');
end;
$$;

-- Read for an authenticated owner: only an active workspace gets credentials.
create or replace function public.meta_access_for_workspace(p_workspace uuid, p_actor text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ws public.workspaces%rowtype;
  v_user public.workspace_meta_credentials%rowtype;
  v_page public.workspace_meta_credentials%rowtype;
  v_conn public.workspace_meta_connections%rowtype;
begin
  select * into v_ws from public.workspaces where id = p_workspace;
  if not found or v_ws.owner_clerk_user_id is distinct from p_actor then return jsonb_build_object('outcome', 'access_denied'); end if;
  if v_ws.status <> 'active' then return jsonb_build_object('outcome', 'workspace_inactive', 'status', v_ws.status); end if;
  select * into v_user from public.workspace_meta_credentials where workspace_id = p_workspace and kind = 'user';
  if not found then return jsonb_build_object('outcome', 'not_connected'); end if;
  select * into v_page from public.workspace_meta_credentials where workspace_id = p_workspace and kind = 'page';
  select * into v_conn from public.workspace_meta_connections where workspace_id = p_workspace;
  return jsonb_build_object('outcome', 'ok', 'workspace_id', p_workspace,
    'user', public.meta_sealed(v_user), 'page', public.meta_sealed(v_page),
    'ad_account_id', v_conn.ad_account_id, 'pixel_id', v_conn.pixel_id, 'page_id', v_conn.page_id, 'page_name', v_conn.page_name,
    'ad_accounts', coalesce(v_conn.ad_accounts, '[]'::jsonb), 'pages', coalesce(v_conn.pages, '[]'::jsonb));
end;
$$;

-- System context (Meta CAPI from an order webhook): the shop's bound, active workspace.
create or replace function public.meta_access_for_shop(p_domain text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
  v_owner text;
  v_user public.workspace_meta_credentials%rowtype;
  v_pixel text;
begin
  select b.workspace_id, w.owner_clerk_user_id into v_workspace, v_owner
    from public.shops s join public.shop_bindings b on b.shop_id = s.id and b.released_at is null
    join public.workspaces w on w.id = b.workspace_id
   where s.myshopify_domain = public.myshopify_domain_or_null(p_domain);
  if v_workspace is null then return jsonb_build_object('outcome', 'not_modelled'); end if;
  if not public.workspace_can_operate(v_workspace) then return jsonb_build_object('outcome', 'workspace_inactive'); end if;
  select * into v_user from public.workspace_meta_credentials where workspace_id = v_workspace and kind = 'user';
  select pixel_id into v_pixel from public.workspace_meta_connections where workspace_id = v_workspace;
  return jsonb_build_object('outcome', case when v_user.workspace_id is null then 'not_connected' else 'ok' end,
    'workspace_id', v_workspace, 'owner', v_owner, 'pixel_id', v_pixel, 'user', public.meta_sealed(v_user));
end;
$$;

create or replace function public.clear_meta_connection(p_workspace uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.workspaces where id = p_workspace and owner_clerk_user_id = p_actor) then
    raise exception 'workspace_access_denied';
  end if;
  delete from public.workspace_meta_credentials where workspace_id = p_workspace;
  delete from public.workspace_meta_connections where workspace_id = p_workspace;
  perform public.log_workspace_event(p_workspace, null, 'meta_disconnected', p_actor, 'user', null, '{}'::jsonb);
  return jsonb_build_object('outcome', 'cleared');
end;
$$;

-- Account deletion revokes each workspace's Meta grant; only the owner's own.
create or replace function public.meta_user_credentials_for_owner(p_actor text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('workspace_id', m.workspace_id) || public.meta_sealed(m)), '[]'::jsonb)
    from public.workspace_meta_credentials m join public.workspaces w on w.id = m.workspace_id
   where w.owner_clerk_user_id = p_actor and m.kind = 'user';
$$;

-- ── Workspace context for an authenticated user ────────────────────────────

-- The preferred workspace when it is the actor's and not being deleted;
-- otherwise the most recently connected active one, then the newest.
create or replace function public.current_workspace_for_actor(p_actor text, p_preferred uuid default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('workspace_id', w.id, 'status', w.status, 'shop_domain', s.myshopify_domain)
    from public.workspaces w
    left join public.shop_bindings b on b.workspace_id = w.id and b.released_at is null
    left join public.shops s on s.id = b.shop_id
   where w.owner_clerk_user_id = p_actor and w.status not in ('deletion_processing', 'deleted')
   order by (w.id = p_preferred) desc nulls last, (w.status = 'active' and b.id is not null) desc,
            w.last_connected_at desc nulls last, w.created_at desc
   limit 1;
$$;

-- The account that currently owns a shop (signed-out "Continue with Shopify").
create or replace function public.shop_owner(p_domain text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select w.owner_clerk_user_id
    from public.shops s join public.shop_bindings b on b.shop_id = s.id and b.released_at is null
    join public.workspaces w on w.id = b.workspace_id
   where s.myshopify_domain = public.myshopify_domain_or_null(p_domain) and w.status not in ('deletion_processing', 'deleted');
$$;

-- Refusals decided before the exchange are now audited too.
create or replace function public.connect_check_under_lease(p_lease_domain text, p_holder uuid, p_actor text, p_transfer uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(p_lease_domain);
  v_result jsonb;
  v_shop uuid;
begin
  if v_domain is null or not public.hold_shop_lease(public.install_lease_key(v_domain), p_holder) then
    return jsonb_build_object('outcome', 'rejected_lease_lost');
  end if;
  if p_transfer is null then
    v_result := public.shop_connection_preflight(v_domain, p_actor);
  elsif exists (
    select 1 from public.ownership_transfers t join public.shops s on s.id = t.shop_id
     where t.id = p_transfer and t.requested_by_clerk_user_id = p_actor and t.status = 'approved'
       and t.expires_at > now() and s.myshopify_domain = v_domain
  ) then
    v_result := jsonb_build_object('outcome', 'allowed');
  else
    v_result := jsonb_build_object('outcome', 'rejected_transfer_not_ready');
  end if;
  if v_result ->> 'outcome' <> 'allowed' then
    select id into v_shop from public.shops where myshopify_domain = v_domain;
    perform public.log_workspace_event(
      (select workspace_id from public.shop_bindings where shop_id = v_shop and released_at is null), v_shop,
      'connect_rejected', p_actor, 'oauth', null, jsonb_build_object('reason', v_result ->> 'outcome', 'stage', 'before_exchange'));
  end if;
  return v_result;
end;
$$;

-- ── Access ─────────────────────────────────────────────────────────────────

alter table public.shop_credentials enable row level security;
alter table public.workspace_meta_credentials enable row level security;
alter table public.workspace_meta_connections enable row level security;

-- Ciphertext tables are not readable by the application role directly: it
-- reads credentials only through the lifecycle-checked functions above.
revoke all on table public.shop_credentials, public.workspace_meta_credentials, public.workspace_meta_connections
  from public, anon, authenticated, service_role;

revoke all on function
  public.sealed_part(jsonb, text), public.store_shop_credential(uuid, uuid, jsonb),
  public.shop_credential_payload(public.shop_credentials, public.shops), public.meta_sealed(public.workspace_meta_credentials),
  public.store_meta_credential(uuid, text, jsonb), public.clear_workspace_credentials(), public.meta_workspace_writable(uuid, text),
  public.commit_shop_install_under_lease(text, uuid, bigint, text, text, uuid, text, uuid, jsonb),
  public.shop_credential_for_workspace(uuid, text), public.shop_credential_for_shop(text),
  public.store_refreshed_shop_credential(uuid, uuid, bigint, jsonb), public.record_shop_refresh_failure(uuid, bigint, boolean, text),
  public.reseal_shop_credential(uuid, bigint, jsonb), public.credentials_below_key_version(integer, integer),
  public.reseal_meta_credential(uuid, text, bigint, jsonb), public.store_meta_connection(uuid, text, jsonb, jsonb, jsonb),
  public.select_meta_ad_account(uuid, text, text), public.select_meta_page(uuid, text, text, jsonb),
  public.meta_access_for_workspace(uuid, text), public.meta_access_for_shop(text), public.clear_meta_connection(uuid, text),
  public.meta_user_credentials_for_owner(text), public.current_workspace_for_actor(text, uuid), public.shop_owner(text),
  public.connect_check_under_lease(text, uuid, text, uuid)
from public, anon, authenticated, service_role;

-- Installation now always stores its credential with the binding.
revoke execute on function
  public.bind_shop_under_lease(text, uuid, bigint, text, text, uuid, text),
  public.complete_transfer_under_lease(text, uuid, uuid, text, bigint)
from service_role;

grant execute on function
  public.commit_shop_install_under_lease(text, uuid, bigint, text, text, uuid, text, uuid, jsonb),
  public.shop_credential_for_workspace(uuid, text), public.shop_credential_for_shop(text),
  public.store_refreshed_shop_credential(uuid, uuid, bigint, jsonb), public.record_shop_refresh_failure(uuid, bigint, boolean, text),
  public.reseal_shop_credential(uuid, bigint, jsonb), public.credentials_below_key_version(integer, integer),
  public.reseal_meta_credential(uuid, text, bigint, jsonb), public.store_meta_connection(uuid, text, jsonb, jsonb, jsonb),
  public.select_meta_ad_account(uuid, text, text), public.select_meta_page(uuid, text, text, jsonb),
  public.meta_access_for_workspace(uuid, text), public.meta_access_for_shop(text), public.clear_meta_connection(uuid, text),
  public.meta_user_credentials_for_owner(text), public.current_workspace_for_actor(text, uuid), public.shop_owner(text),
  public.connect_check_under_lease(text, uuid, text, uuid)
to service_role;
