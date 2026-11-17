-- 0022: legacy account migration (Phase 1, task 6).
-- Design: architecture/phase-1-data-model.md, "Legacy migration from user_integrations".
--
-- One workspace per legacy user_integrations row, owned by that row's Clerk
-- user; accounts are never merged. Each migrated row records what happened to
-- it in legacy_account_map, so the migration is idempotent and auditable.
-- Records that belong to no legacy account are listed in legacy_orphans and
-- attached nowhere. The functions are run by scripts/ops/legacy-migration.mjs
-- as the database owner: a dry run inside a rolled-back transaction first,
-- then the apply. Plaintext credential clearing is a separate, explicit step.
--
-- Additive: creates tables and functions only. Rows change only when the
-- migration functions are run. Requires 0023 (workspace_id on tenant tables)
-- before migrate_legacy_account is called; the functions resolve it at run time.

create table public.legacy_account_map (
  legacy_row_id         uuid primary key,
  clerk_user_id         text not null,
  workspace_id          uuid not null references public.workspaces (id),
  claim_id              uuid references public.legacy_shop_claims (id),
  claim_status          text,
  opening_entry_id      bigint references public.credit_ledger (id),
  opening_balance       integer not null,
  opening_needs_review  boolean not null default false,
  attributed            jsonb not null default '{}'::jsonb,
  purchases_recorded    integer not null default 0,
  credential_outcome    text not null check (credential_outcome in ('none', 'retired_unbound', 'cleared')),
  migrated_at           timestamptz not null default now(),
  credential_cleared_at timestamptz,
  run_id                text
);
create unique index legacy_account_map_workspace on public.legacy_account_map (workspace_id);

create table public.legacy_orphans (
  id             bigint generated always as identity primary key,
  source_table   text not null,
  source_id      text not null,
  clerk_user_id  text,
  reason         text not null,
  details        jsonb not null default '{}'::jsonb,
  recorded_at    timestamptz not null default now(),
  run_id         text,
  unique (source_table, source_id)
);

-- The legacy plaintext credential columns, wherever this schema has them.
create or replace function public.legacy_token_columns()
returns text[] language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(column_name::text order by column_name), '{}') from information_schema.columns
   where table_schema = 'public' and table_name = 'user_integrations'
     and column_name = any(array['shopify_access_token', 'access_token', 'shopify_refresh_token', 'refresh_token',
       'meta_access_token', 'meta_page_access_token']);
$$;

create or replace function public.legacy_row_has_credentials(p_legacy_row uuid)
returns boolean language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_found boolean;
begin
  execute format('select exists (select 1 from public.user_integrations where id = $1 and (%s))',
    (select coalesce(string_agg(format('%I is not null', c), ' or '), 'false') from unnest(public.legacy_token_columns()) c))
    into v_found using p_legacy_row;
  return v_found;
end;
$$;

-- Migrates one legacy account. Idempotent: a mapped row is reported, never redone.
create or replace function public.migrate_legacy_account(p_legacy_row uuid, p_run text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u public.user_integrations%rowtype;
  v_map public.legacy_account_map%rowtype;
  v_reg jsonb;
  v_ws uuid;
  v_claim public.legacy_shop_claims%rowtype;
  v_open jsonb;
  v_attr jsonb := '{}'::jsonb;
  v_count integer;
  v_purchases integer;
  v_credential text;
begin
  select * into v_map from public.legacy_account_map where legacy_row_id = p_legacy_row;
  if found then
    return jsonb_build_object('outcome', 'already_migrated', 'workspace_id', v_map.workspace_id, 'claim_status', v_map.claim_status);
  end if;
  select * into u from public.user_integrations where id = p_legacy_row for update;
  if not found then raise exception 'legacy_row_not_found'; end if;

  -- Workspace and shop claim (0018). The domain binds only at the owner's next connection.
  v_reg := public.register_legacy_account(u.id, u.clerk_user_id, coalesce(nullif(btrim(u.shop_domain), ''), u.shopify_store_url));
  v_ws := (v_reg ->> 'workspace_id')::uuid;
  select * into v_claim from public.legacy_shop_claims where id = (v_reg ->> 'claim_id')::uuid;
  -- A shop already connected through the new model cannot be bound by a legacy claim.
  if v_claim.status in ('provisional', 'contested') and exists (
       select 1 from public.shops s join public.shop_bindings b on b.shop_id = s.id and b.released_at is null
        where s.myshopify_domain = v_claim.claimed_domain) then
    update public.legacy_shop_claims set status = 'unresolved', review_note = 'domain_already_connected'
     where id = v_claim.id returning * into v_claim;
  end if;

  -- Opening balance: equals the legacy balance; unexplained differences go to review (0021).
  v_open := public.open_legacy_credit_balance(v_ws);

  -- The account's history moves with it. Rows already attributed are left alone.
  update public.campaigns set workspace_id = v_ws where clerk_user_id = u.clerk_user_id and workspace_id is null;
  get diagnostics v_count = row_count; v_attr := v_attr || jsonb_build_object('campaigns', v_count);
  update public.campaign_brief_versions v set workspace_id = v_ws
    from public.campaigns c where v.campaign_id = c.id and c.workspace_id = v_ws and v.workspace_id is null;
  get diagnostics v_count = row_count; v_attr := v_attr || jsonb_build_object('brief_versions', v_count);
  update public.brief_generation_receipts set workspace_id = v_ws where clerk_user_id = u.clerk_user_id and workspace_id is null;
  get diagnostics v_count = row_count; v_attr := v_attr || jsonb_build_object('receipts', v_count);
  update public.payments set workspace_id = v_ws where clerk_user_id = u.clerk_user_id and workspace_id is null;
  get diagnostics v_count = row_count; v_attr := v_attr || jsonb_build_object('payments', v_count);
  update public.credit_usage set workspace_id = v_ws where clerk_user_id = u.clerk_user_id and workspace_id is null;
  get diagnostics v_count = row_count; v_attr := v_attr || jsonb_build_object('credit_usage', v_count);
  update public.capi_events set workspace_id = v_ws where clerk_user_id = u.clerk_user_id and workspace_id is null;
  get diagnostics v_count = row_count; v_attr := v_attr || jsonb_build_object('capi_events', v_count);

  -- Known purchases, recorded against this account. Their credits are already in the
  -- opening balance, so they are never credited again (reconciliation sees legacy_claimed).
  insert into public.provider_purchases (provider, external_id, kind, workspace_id, purchaser_clerk_user_id, attribution,
    review_status, provider_status, plan_key, credits, unlimited_days, amount, currency, provider_created_at, details)
  select p.provider, coalesce(nullif(btrim(p.provider_reference), ''), p.id::text), 'one_time', v_ws, u.clerk_user_id,
         'legacy_record', 'legacy_claimed', p.status, p.pack, coalesce(p.credits_granted, 0), coalesce(p.unlimited_days, 0),
         coalesce(p.amount_usd, p.amount_ngn), p.currency, p.created_at,
         jsonb_build_object('legacy_payment_id', p.id, 'legacy_row_id', u.id)
    from public.payments p
   where p.clerk_user_id = u.clerk_user_id and p.status = 'success' and p.provider in ('shopify', 'stripe', 'paystack')
  on conflict (provider, external_id) do nothing;
  get diagnostics v_purchases = row_count;

  -- Credentials: a legacy row has no Shopify shop id, so no shop is bound now and its
  -- plaintext tokens cannot be carried over. They are retired; clearing is a separate step.
  v_credential := case when public.legacy_row_has_credentials(u.id) then 'retired_unbound' else 'none' end;

  insert into public.legacy_account_map (legacy_row_id, clerk_user_id, workspace_id, claim_id, claim_status, opening_entry_id,
    opening_balance, opening_needs_review, attributed, purchases_recorded, credential_outcome, run_id)
  values (u.id, u.clerk_user_id, v_ws, v_claim.id, v_claim.status, (v_open ->> 'entry_id')::bigint,
    coalesce((v_open -> 'reconciliation' ->> 'legacy_balance')::integer, 0), coalesce((v_open ->> 'needs_review')::boolean, false),
    v_attr, v_purchases, v_credential, p_run);
  perform public.log_workspace_event(v_ws, null, 'legacy_migrated', u.clerk_user_id, 'migration', null,
    jsonb_build_object('legacy_row_id', u.id, 'run_id', p_run));

  return jsonb_build_object('outcome', 'migrated', 'workspace_id', v_ws, 'claim_status', v_claim.status,
    'opening_balance', (v_open -> 'reconciliation' ->> 'legacy_balance')::integer, 'opening_needs_review', v_open -> 'needs_review',
    'difference', (v_open -> 'reconciliation' ->> 'difference')::integer, 'attributed', v_attr,
    'purchases_recorded', v_purchases, 'credential', v_credential);
end;
$$;

-- Records with no legacy account and no workspace: listed for review, attached nowhere.
create or replace function public.record_legacy_orphans(p_run text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_table text;
  v_count integer;
begin
  foreach v_table in array array['campaigns', 'payments', 'credit_usage', 'brief_generation_receipts', 'capi_events'] loop
    execute format(
      'insert into public.legacy_orphans (source_table, source_id, clerk_user_id, reason, run_id)
       select %L, %s, t.clerk_user_id, ''no_legacy_account'', $1 from public.%I t
        where t.workspace_id is null
          and not exists (select 1 from public.user_integrations u where u.clerk_user_id = t.clerk_user_id)
       on conflict (source_table, source_id) do nothing',
      v_table, case when v_table = 'brief_generation_receipts' then 't.clerk_user_id || '':'' || t.request_id::text' else 't.id::text' end, v_table)
      using p_run;
    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_object(v_table, v_count);
  end loop;
  return v_result;
end;
$$;

-- Irreversible: nulls the plaintext credential columns of one migrated legacy row.
-- Run only after a verified backup and restore (scripts/ops/runbooks/backups.md).
create or replace function public.clear_legacy_plaintext_credentials(p_legacy_row uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_map public.legacy_account_map%rowtype;
begin
  select * into v_map from public.legacy_account_map where legacy_row_id = p_legacy_row for update;
  if not found then raise exception 'legacy_row_not_migrated'; end if;
  if v_map.credential_outcome <> 'retired_unbound' then return v_map.credential_outcome; end if;
  execute format('update public.user_integrations set %s where id = $1',
    (select string_agg(format('%I = null', c), ', ') from unnest(public.legacy_token_columns()) c)) using p_legacy_row;
  update public.legacy_account_map set credential_outcome = 'cleared', credential_cleared_at = now() where legacy_row_id = p_legacy_row;
  return 'cleared';
end;
$$;

alter table public.legacy_account_map enable row level security;
alter table public.legacy_orphans enable row level security;
revoke all on table public.legacy_account_map, public.legacy_orphans from public, anon, authenticated, service_role;
grant select on table public.legacy_account_map, public.legacy_orphans to service_role;

-- Migration functions run as the database owner only.
revoke all on function public.legacy_token_columns(), public.legacy_row_has_credentials(uuid),
  public.migrate_legacy_account(uuid, text), public.record_legacy_orphans(text),
  public.clear_legacy_plaintext_credentials(uuid)
from public, anon, authenticated, service_role;
