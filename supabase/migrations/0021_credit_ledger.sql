-- 0021: canonical workspace credit ledger (Phase 1, task 5).
-- Design: architecture/phase-1-data-model.md, "Credits".
--
-- Credits belong to a workspace. Every balance change is one append-only
-- ledger entry written by apply_credit_mutation in the same transaction as the
-- balance, and a trigger refuses any other change to credit_accounts.balance.
-- Purchases are recorded in provider_purchases (the payment record) in the
-- same transaction as their ledger entry or entitlement, so neither can exist
-- without the other. Attribution comes from a purchase intent written when
-- the purchase starts; a purchase without one is credited only to the
-- workspace whose verified binding unambiguously covered its date, and is
-- otherwise left unattributed for review.
--
-- Additive: no existing row changes. The legacy user-keyed credit functions
-- are retired (they now raise) because they wrote balances outside the ledger;
-- legacy balances in user_integrations are left untouched and are carried into
-- a legacy workspace only by open_legacy_credit_balance (task 6).

-- ── Balance guard ────────────────────────────────────────────────────────────

-- The ledger starts from zero balances, so balance = sum(ledger) holds from
-- the first entry. 0018 created every account at zero and nothing changed them.
do $$
begin
  if exists (select 1 from public.credit_accounts where balance <> 0) then
    raise exception 'credit_accounts_hold_unledgered_balances';
  end if;
end;
$$;

create or replace function public.guard_credit_account()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.balance <> 0 then raise exception 'credit_balance_changes_only_through_ledger'; end if;
    return new;
  end if;
  if new.balance is distinct from old.balance
     and coalesce(current_setting('omnitarget.credit_mutation', true), '') <> 'on' then
    raise exception 'credit_balance_changes_only_through_ledger';
  end if;
  return new;
end;
$$;
create trigger credit_accounts_guard before insert or update on public.credit_accounts
  for each row execute function public.guard_credit_account();

-- ── Tables ───────────────────────────────────────────────────────────────────

create table public.credit_ledger (
  id                   bigint generated always as identity primary key,
  workspace_id         uuid not null references public.workspaces (id),
  entry_type           text not null check (entry_type in (
                         'opening_balance', 'purchase', 'free_grant', 'consumption',
                         'adjustment', 'refund', 'reversal', 'subscription_grant')),
  quantity             integer not null,
  balance_after        integer not null check (balance_after >= 0),
  actor_clerk_user_id  text,
  shop_id              uuid references public.shops (id),
  provider             text check (provider in ('shopify', 'stripe', 'paystack', 'legacy')),
  external_reference   text,
  idempotency_key      text not null unique check (btrim(idempotency_key) <> ''),
  reason               text,
  reverses_entry_id    bigint references public.credit_ledger (id),
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  constraint credit_ledger_sign check (case entry_type
    when 'opening_balance' then quantity >= 0
    when 'purchase' then quantity > 0
    when 'free_grant' then quantity > 0
    when 'subscription_grant' then quantity > 0
    when 'consumption' then quantity < 0
    when 'refund' then quantity < 0
    else quantity <> 0 end),
  constraint credit_ledger_reversal check ((entry_type = 'reversal') = (reverses_entry_id is not null)),
  constraint credit_ledger_provider_reference check (
    entry_type not in ('purchase', 'subscription_grant', 'refund') or (provider is not null and external_reference is not null))
);
create index credit_ledger_workspace_idx on public.credit_ledger (workspace_id, id);
create unique index credit_ledger_provider_reference_once on public.credit_ledger (provider, external_reference, entry_type)
  where entry_type in ('purchase', 'subscription_grant', 'refund');
create unique index credit_ledger_free_grant_per_workspace on public.credit_ledger (workspace_id) where entry_type = 'free_grant';
create unique index credit_ledger_free_grant_per_shop on public.credit_ledger (shop_id) where entry_type = 'free_grant' and shop_id is not null;
create unique index credit_ledger_opening_per_workspace on public.credit_ledger (workspace_id) where entry_type = 'opening_balance';
create unique index credit_ledger_one_reversal on public.credit_ledger (reverses_entry_id) where entry_type = 'reversal';
create trigger credit_ledger_append_only before update or delete on public.credit_ledger
  for each row execute function public.reject_row_mutation();
create trigger credit_ledger_no_truncate before truncate on public.credit_ledger
  for each statement execute function public.reject_row_mutation();

-- Unlimited access is a dated entitlement, never a balance.
create table public.credit_entitlements (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces (id),
  kind                 text not null check (kind in ('unlimited')),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  provider             text not null check (provider in ('shopify', 'stripe', 'paystack', 'legacy', 'support')),
  external_reference   text,
  idempotency_key      text not null unique check (btrim(idempotency_key) <> ''),
  actor_clerk_user_id  text,
  reason               text,
  created_at           timestamptz not null default now(),
  revoked_at           timestamptz,
  revoked_by           text,
  revoke_reason        text,
  constraint credit_entitlements_period check (ends_at > starts_at),
  constraint credit_entitlements_revocation check ((revoked_at is null) = (revoke_reason is null))
);
create index credit_entitlements_workspace_idx on public.credit_entitlements (workspace_id, ends_at) where revoked_at is null;

create or replace function public.guard_credit_entitlement()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' or old.revoked_at is not null
     or (new.id, new.workspace_id, new.kind, new.starts_at, new.ends_at, new.provider, new.external_reference,
         new.idempotency_key, new.actor_clerk_user_id, new.reason, new.created_at)
        is distinct from
        (old.id, old.workspace_id, old.kind, old.starts_at, old.ends_at, old.provider, old.external_reference,
         old.idempotency_key, old.actor_clerk_user_id, old.reason, old.created_at) then
    raise exception 'entitlements_change_only_by_revocation';
  end if;
  return new;
end;
$$;
create trigger credit_entitlements_guard before update or delete on public.credit_entitlements
  for each row execute function public.guard_credit_entitlement();

-- Written when a purchase starts, by the authenticated purchaser, for their workspace.
create table public.purchase_intents (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references public.workspaces (id),
  shop_id                  uuid references public.shops (id),
  purchaser_clerk_user_id  text not null check (btrim(purchaser_clerk_user_id) <> ''),
  provider                 text not null check (provider in ('shopify', 'stripe', 'paystack')),
  plan_key                 text not null check (btrim(plan_key) <> ''),
  kind                     text not null check (kind in ('one_time', 'subscription')),
  credits                  integer not null default 0 check (credits >= 0),
  unlimited_days           integer not null default 0 check (unlimited_days >= 0),
  amount                   numeric,
  currency                 text,
  external_charge_id       text check (external_charge_id is null or btrim(external_charge_id) <> ''),
  status                   text not null default 'created' check (status in ('created', 'pending', 'granted', 'failed')),
  failure_reason           text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  granted_at               timestamptz,
  constraint purchase_intents_grants_something check (credits > 0 or unlimited_days > 0),
  constraint purchase_intents_granted check ((status = 'granted') = (granted_at is not null)),
  constraint purchase_intents_shopify_shop check (provider <> 'shopify' or shop_id is not null)
);
create unique index purchase_intents_charge on public.purchase_intents (provider, external_charge_id) where external_charge_id is not null;
create index purchase_intents_workspace_idx on public.purchase_intents (workspace_id, created_at);

-- The payment record: one row per provider charge (or subscription period).
create table public.provider_purchases (
  id                       uuid primary key default gen_random_uuid(),
  provider                 text not null check (provider in ('shopify', 'stripe', 'paystack')),
  external_id              text not null check (btrim(external_id) <> ''),
  kind                     text not null check (kind in ('one_time', 'subscription_period')),
  shop_id                  uuid references public.shops (id),
  workspace_id             uuid references public.workspaces (id),
  intent_id                uuid references public.purchase_intents (id),
  purchaser_clerk_user_id  text,
  attribution              text not null check (attribution in ('intent', 'binding_period', 'legacy_record', 'unattributed')),
  review_status            text not null check (review_status in (
                             'granted', 'needs_review', 'legacy_claimed', 'not_creditable', 'reversed', 'refunded')),
  provider_status          text,
  plan_key                 text,
  credits                  integer not null default 0 check (credits >= 0),
  unlimited_days           integer not null default 0 check (unlimited_days >= 0),
  amount                   numeric,
  currency                 text,
  test                     boolean,
  provider_created_at      timestamptz,
  ledger_entry_id          bigint unique references public.credit_ledger (id),
  entitlement_id           uuid unique references public.credit_entitlements (id),
  details                  jsonb not null default '{}'::jsonb,
  recorded_at              timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (provider, external_id),
  constraint provider_purchases_settled check (
    review_status not in ('granted', 'reversed', 'refunded')
    or (workspace_id is not null and (ledger_entry_id is not null or entitlement_id is not null))),
  constraint provider_purchases_unattributed check (
    attribution <> 'unattributed' or (workspace_id is null and ledger_entry_id is null and entitlement_id is null)),
  constraint provider_purchases_intent check ((attribution = 'intent') = (intent_id is not null))
);
create index provider_purchases_shop_idx on public.provider_purchases (shop_id, provider_created_at);
create index provider_purchases_review_idx on public.provider_purchases (review_status) where review_status in ('needs_review', 'legacy_claimed');

-- Durable cursor for paging through a shop's full purchase history.
create table public.billing_sync_state (
  shop_id            uuid primary key references public.shops (id),
  cursor             text,
  last_started_at    timestamptz,
  last_completed_at  timestamptz,
  last_error         text,
  updated_at         timestamptz not null default now()
);

-- Opening balances that the legacy records do not fully explain.
create table public.credit_opening_reviews (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references public.workspaces (id),
  legacy_user_integration_id  uuid not null unique,
  clerk_user_id               text not null,
  legacy_balance              integer not null,
  explained_balance           integer not null,
  difference                  integer not null,
  components                  jsonb not null,
  status                      text not null default 'open' check (status in ('open', 'resolved')),
  created_at                  timestamptz not null default now(),
  resolved_at                 timestamptz,
  resolved_by                 text,
  resolution_note             text,
  constraint credit_opening_reviews_resolution check ((status = 'resolved') = (resolved_at is not null))
);

-- ── Canonical operation ──────────────────────────────────────────────────────

-- The only writer of credit_accounts.balance. Internal: the application calls
-- the typed operations below, never this directly, so a purchase entry cannot
-- be written without its payment record.
create or replace function public.apply_credit_mutation(
  p_workspace uuid, p_type text, p_quantity integer, p_idempotency_key text, p_actor text,
  p_shop uuid, p_provider text, p_external_reference text, p_reason text, p_metadata jsonb,
  p_reverses bigint default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account public.credit_accounts%rowtype;
  v_existing public.credit_ledger%rowtype;
  v_balance integer;
  v_id bigint;
begin
  if coalesce(btrim(p_idempotency_key), '') = '' then raise exception 'idempotency_key_required'; end if;
  if p_quantity is null then raise exception 'quantity_required'; end if;

  select * into v_account from public.credit_accounts where workspace_id = p_workspace for update;
  if not found then raise exception 'credit_account_not_found'; end if;

  select * into v_existing from public.credit_ledger where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.workspace_id <> p_workspace or v_existing.entry_type <> p_type or v_existing.quantity <> p_quantity then
      raise exception 'idempotency_conflict';
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'entry_id', v_existing.id, 'balance', v_account.balance);
  end if;

  v_balance := v_account.balance + p_quantity;
  if v_balance < 0 then raise exception 'insufficient_credits'; end if;

  insert into public.credit_ledger (workspace_id, entry_type, quantity, balance_after, actor_clerk_user_id, shop_id,
    provider, external_reference, idempotency_key, reason, reverses_entry_id, metadata)
  values (p_workspace, p_type, p_quantity, v_balance, p_actor, p_shop, p_provider, p_external_reference,
    p_idempotency_key, p_reason, p_reverses, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;

  perform set_config('omnitarget.credit_mutation', 'on', true);
  update public.credit_accounts set balance = v_balance, updated_at = now() where workspace_id = p_workspace;
  perform set_config('omnitarget.credit_mutation', 'off', true);

  return jsonb_build_object('outcome', 'applied', 'entry_id', v_id, 'balance', v_balance);
end;
$$;

create or replace function public.workspace_unlimited_until(p_workspace uuid)
returns timestamptz language sql stable security definer set search_path = public, pg_temp as $$
  select case when exists (select 1 from public.credit_entitlements e
                            where e.workspace_id = p_workspace and e.revoked_at is null
                              and e.starts_at <= now() and e.ends_at > now())
              then (select max(e.ends_at) from public.credit_entitlements e
                     where e.workspace_id = p_workspace and e.revoked_at is null and e.ends_at > now())
         end;
$$;

-- Balance and unlimited access for the workspace's owner.
create or replace function public.workspace_credit_status(p_workspace uuid, p_actor text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_until timestamptz;
begin
  perform public.workspace_for_actor(p_workspace, p_actor);
  v_until := public.workspace_unlimited_until(p_workspace);
  return jsonb_build_object('workspace_id', p_workspace,
    'balance', (select balance from public.credit_accounts where workspace_id = p_workspace),
    'unlimited_until', v_until, 'is_unlimited', v_until is not null);
end;
$$;

-- ── Purchases ────────────────────────────────────────────────────────────────

create or replace function public.current_shop_of(p_workspace uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select shop_id from public.shop_bindings where workspace_id = p_workspace and released_at is null;
$$;

-- Records who is buying what, for which workspace, before any provider call.
create or replace function public.create_purchase_intent(
  p_workspace uuid, p_actor text, p_provider text, p_plan_key text, p_kind text,
  p_credits integer, p_unlimited_days integer, p_amount numeric, p_currency text,
  p_external_charge_id text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ws jsonb := public.workspace_for_actor(p_workspace, p_actor);
  v_shop uuid := public.current_shop_of(p_workspace);
  v_id uuid;
begin
  if v_ws ->> 'status' <> 'active' then raise exception 'workspace_inactive'; end if;
  if p_provider = 'shopify' and v_shop is null then raise exception 'shop_not_connected'; end if;
  insert into public.purchase_intents (workspace_id, shop_id, purchaser_clerk_user_id, provider, plan_key, kind,
    credits, unlimited_days, amount, currency, external_charge_id, status)
  values (p_workspace, v_shop, p_actor, p_provider, p_plan_key, p_kind, coalesce(p_credits, 0), coalesce(p_unlimited_days, 0),
    p_amount, p_currency, p_external_charge_id, case when p_external_charge_id is null then 'created' else 'pending' end)
  returning id into v_id;
  return jsonb_build_object('intent_id', v_id, 'workspace_id', p_workspace, 'shop_id', v_shop, 'shop_domain', v_ws ->> 'shop_domain');
end;
$$;

-- Links the provider's charge to the intent once the provider has created it.
create or replace function public.attach_intent_charge(p_intent uuid, p_external_charge_id text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  if coalesce(btrim(p_external_charge_id), '') = '' then raise exception 'charge_id_required'; end if;
  update public.purchase_intents set external_charge_id = p_external_charge_id, status = 'pending', updated_at = now()
   where id = p_intent and status = 'created' and external_charge_id is null;
  get diagnostics v_count = row_count;
  if v_count = 1 then return true; end if;
  return exists (select 1 from public.purchase_intents where id = p_intent and external_charge_id = p_external_charge_id);
exception when unique_violation then
  raise exception 'charge_already_attached';
end;
$$;

create or replace function public.fail_purchase_intent(p_intent uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  update public.purchase_intents set status = 'failed', failure_reason = left(p_reason, 500), updated_at = now()
   where id = p_intent and status in ('created', 'pending');
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- Settles one provider charge: payment record plus ledger entry or entitlement,
-- in one transaction. Internal; reached through the two wrappers below.
create or replace function public.settle_purchase(
  p_provider text, p_external_id text, p_kind text, p_shop uuid, p_workspace uuid, p_intent uuid,
  p_attribution text, p_plan_key text, p_credits integer, p_unlimited_days integer, p_actor text,
  p_provider_status text, p_test boolean, p_creditable boolean, p_amount numeric, p_currency text,
  p_provider_created_at timestamptz, p_details jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pp public.provider_purchases%rowtype;
  v_exists boolean;
  v_review text;
  v_ws_status text;
  v_entry bigint;
  v_entitlement uuid;
  v_start timestamptz;
  v_result jsonb;
  v_key text := 'purchase:' || p_provider || ':' || p_external_id;
begin
  if coalesce(btrim(p_external_id), '') = '' then raise exception 'external_id_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:purchase:' || p_provider || ':' || p_external_id, 0));

  select * into v_pp from public.provider_purchases where provider = p_provider and external_id = p_external_id for update;
  v_exists := found;
  if v_exists and (v_pp.review_status <> 'not_creditable' or not p_creditable) then
    update public.provider_purchases set provider_status = coalesce(p_provider_status, provider_status), updated_at = now()
     where id = v_pp.id;
    return jsonb_build_object('outcome', case when v_pp.review_status = 'granted' then 'duplicate' else v_pp.review_status end,
      'purchase_id', v_pp.id, 'workspace_id', v_pp.workspace_id, 'ledger_entry_id', v_pp.ledger_entry_id,
      'entitlement_id', v_pp.entitlement_id);
  end if;

  -- Decide the outcome before writing anything.
  if exists (select 1 from public.processed_payments
              where payment_id in (p_external_id, p_provider || ':' || p_external_id))
     -- The legacy code credited a subscription once, keyed by its id: the
     -- periods that had started by then are covered; later renewals are not.
     or (p_kind = 'subscription_period' and exists (
           select 1 from public.processed_payments
            where payment_id = p_provider || ':' || split_part(p_external_id, '@', 1)
              and (p_provider_created_at is null or processed_at >= p_provider_created_at))) then
    v_review := 'legacy_claimed';            -- already credited by the legacy code; never again
  elsif not p_creditable then
    v_review := 'not_creditable';
  elsif p_attribution = 'unattributed' or p_workspace is null then
    v_review := 'needs_review';
  else
    select status into v_ws_status from public.workspaces where id = p_workspace;
    v_review := case when v_ws_status in ('deletion_processing', 'deleted') then 'needs_review' else 'granted' end;
  end if;

  if v_review = 'granted' then
    if p_unlimited_days > 0 then
      v_start := greatest(now(), coalesce((select max(ends_at) from public.credit_entitlements
                                           where workspace_id = p_workspace and revoked_at is null and ends_at > now()), now()));
      insert into public.credit_entitlements (workspace_id, kind, starts_at, ends_at, provider, external_reference,
        idempotency_key, actor_clerk_user_id, reason)
      values (p_workspace, 'unlimited', v_start, v_start + make_interval(days => p_unlimited_days), p_provider, p_external_id,
        v_key, p_actor, 'purchase:' || coalesce(p_plan_key, ''))
      returning id into v_entitlement;
    end if;
    if p_credits > 0 then
      v_result := public.apply_credit_mutation(p_workspace,
        case when p_kind = 'subscription_period' then 'subscription_grant' else 'purchase' end,
        p_credits, v_key, p_actor, p_shop, p_provider, p_external_id, 'purchase:' || coalesce(p_plan_key, ''),
        jsonb_build_object('attribution', p_attribution, 'intent_id', p_intent));
      v_entry := (v_result ->> 'entry_id')::bigint;
    end if;
    if v_entry is null and v_entitlement is null then raise exception 'purchase_grants_nothing'; end if;
    -- Stripe and Paystack purchases start from a payments row; it settles here too.
    if p_provider in ('stripe', 'paystack') then
      update public.payments set status = 'success', updated_at = now(),
             provider_reference = coalesce(p_details ->> 'provider_reference', provider_reference)
       where id::text = p_external_id;
      if not found then raise exception 'payment_record_missing'; end if;
    end if;
    if p_intent is not null then
      update public.purchase_intents set status = 'granted', granted_at = now(), updated_at = now() where id = p_intent;
    end if;
  end if;

  if v_exists then
    update public.provider_purchases set review_status = v_review, provider_status = p_provider_status,
           ledger_entry_id = v_entry, entitlement_id = v_entitlement, test = p_test, updated_at = now()
     where id = v_pp.id
     returning * into v_pp;
  else
    insert into public.provider_purchases (provider, external_id, kind, shop_id, workspace_id, intent_id,
      purchaser_clerk_user_id, attribution, review_status, provider_status, plan_key, credits, unlimited_days,
      amount, currency, test, provider_created_at, ledger_entry_id, entitlement_id, details)
    values (p_provider, p_external_id, p_kind, p_shop,
      case when p_attribution = 'unattributed' or v_review = 'legacy_claimed' then null else p_workspace end,
      case when v_review = 'legacy_claimed' then null else p_intent end,
      case when v_review = 'legacy_claimed' then null else p_actor end,
      case when v_review = 'legacy_claimed' then 'legacy_record' else p_attribution end,
      v_review, p_provider_status, p_plan_key, coalesce(p_credits, 0), coalesce(p_unlimited_days, 0), p_amount, p_currency,
      p_test, p_provider_created_at, v_entry, v_entitlement, coalesce(p_details, '{}'::jsonb))
    returning * into v_pp;
  end if;

  return jsonb_build_object('outcome', v_review, 'purchase_id', v_pp.id, 'workspace_id', v_pp.workspace_id,
    'ledger_entry_id', v_entry, 'entitlement_id', v_entitlement, 'balance', v_result -> 'balance');
end;
$$;

-- A charge started by a purchase intent: credited to that intent's workspace and purchaser.
create or replace function public.grant_intent_purchase(
  p_provider text, p_external_id text, p_plan_key text, p_provider_status text, p_test boolean, p_creditable boolean,
  p_amount numeric, p_currency text, p_provider_created_at timestamptz, p_details jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_intent public.purchase_intents%rowtype;
begin
  select * into v_intent from public.purchase_intents
   where provider = p_provider and external_charge_id = p_external_id for update;
  if not found then return jsonb_build_object('outcome', 'no_intent'); end if;
  if p_plan_key is not null and p_plan_key <> v_intent.plan_key then raise exception 'intent_plan_mismatch'; end if;
  return public.settle_purchase(p_provider, p_external_id,
    case when v_intent.kind = 'subscription' then 'subscription_period' else 'one_time' end,
    v_intent.shop_id, v_intent.workspace_id, v_intent.id, 'intent', v_intent.plan_key, v_intent.credits,
    v_intent.unlimited_days, v_intent.purchaser_clerk_user_id, p_provider_status, p_test, p_creditable,
    coalesce(p_amount, v_intent.amount), coalesce(p_currency, v_intent.currency), p_provider_created_at, p_details);
end;
$$;

-- A Shopify charge found by reconciliation. An intent decides when there is
-- one. Otherwise the charge goes to the workspace whose binding of this shop
-- covered the charge date by more than ten minutes on both sides; any doubt
-- leaves it unattributed for review.
create or replace function public.record_shop_purchase(
  p_shop uuid, p_external_id text, p_kind text, p_plan_key text, p_credits integer, p_provider_status text,
  p_test boolean, p_creditable boolean, p_amount numeric, p_currency text, p_provider_created_at timestamptz,
  p_details jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_margin constant interval := interval '10 minutes';
  v_result jsonb;
  v_ws uuid;
  v_candidates integer;
begin
  if not exists (select 1 from public.shops where id = p_shop) then raise exception 'shop_not_found'; end if;
  if p_kind = 'one_time' then
    v_result := public.grant_intent_purchase('shopify', p_external_id, p_plan_key, p_provider_status, p_test, p_creditable,
      p_amount, p_currency, p_provider_created_at, p_details);
    if v_result ->> 'outcome' <> 'no_intent' then return v_result; end if;
  end if;

  if p_provider_created_at is not null then
    select count(*) into v_candidates from public.shop_bindings b
     where b.shop_id = p_shop
       and b.bound_at <= p_provider_created_at + v_margin
       and (b.released_at is null or b.released_at >= p_provider_created_at - v_margin);
    if v_candidates = 1 then
      select b.workspace_id into v_ws from public.shop_bindings b
       where b.shop_id = p_shop
         and b.bound_at <= p_provider_created_at - v_margin
         and (b.released_at is null or b.released_at >= p_provider_created_at + v_margin);
    end if;
  end if;

  return public.settle_purchase('shopify', p_external_id, p_kind, p_shop, v_ws, null,
    case when v_ws is null then 'unattributed' else 'binding_period' end, p_plan_key, p_credits, 0, null,
    p_provider_status, p_test, p_creditable, p_amount, p_currency, p_provider_created_at, p_details);
end;
$$;

-- ── Other credit operations ─────────────────────────────────────────────────

-- One free credit per workspace and per shop, granted at connection.
create or replace function public.grant_workspace_free_credit(p_workspace uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop uuid;
  v_result jsonb;
begin
  perform public.workspace_for_actor(p_workspace, p_actor);
  if not public.workspace_can_operate(p_workspace) then return jsonb_build_object('outcome', 'workspace_inactive'); end if;
  v_shop := public.current_shop_of(p_workspace);
  perform 1 from public.credit_accounts where workspace_id = p_workspace for update;
  perform pg_advisory_xact_lock(hashtextextended('omnitarget:free-grant-shop:' || v_shop::text, 0));
  if exists (select 1 from public.credit_ledger where workspace_id = p_workspace and entry_type = 'free_grant') then
    return jsonb_build_object('outcome', 'already_granted');
  end if;
  if exists (select 1 from public.credit_ledger where shop_id = v_shop and entry_type = 'free_grant') then
    return jsonb_build_object('outcome', 'shop_already_granted');
  end if;
  if exists (select 1 from public.credit_ledger where workspace_id = p_workspace and entry_type = 'opening_balance'
              and coalesce((metadata ->> 'free_credit_used')::boolean, false)) then
    return jsonb_build_object('outcome', 'legacy_free_credit_used');
  end if;
  v_result := public.apply_credit_mutation(p_workspace, 'free_grant', 1, 'free:' || p_workspace::text, p_actor, v_shop,
    null, null, 'free_install_credit', '{}'::jsonb);
  return jsonb_build_object('outcome', 'granted', 'entry_id', v_result -> 'entry_id', 'balance', v_result -> 'balance');
end;
$$;

-- Support adjustments: an actor, a reason and an idempotency key are mandatory.
create or replace function public.adjust_workspace_credits(
  p_workspace uuid, p_delta integer, p_idempotency_key text, p_actor text, p_reason text, p_evidence jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(btrim(p_reason), '') = '' or coalesce(btrim(p_actor), '') = '' then raise exception 'adjustment_actor_and_reason_required'; end if;
  if coalesce(p_delta, 0) = 0 then raise exception 'adjustment_delta_required'; end if;
  if coalesce(btrim(p_idempotency_key), '') = '' then raise exception 'idempotency_key_required'; end if;
  return public.apply_credit_mutation(p_workspace, 'adjustment', p_delta, 'adjust:' || p_idempotency_key, p_actor,
    null, null, null, p_reason, jsonb_build_object('evidence', coalesce(p_evidence, '{}'::jsonb)));
end;
$$;

-- Reverses one entry exactly once. Refused if the balance cannot cover it.
create or replace function public.reverse_credit_entry(p_entry bigint, p_idempotency_key text, p_actor text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entry public.credit_ledger%rowtype;
  v_result jsonb;
begin
  if coalesce(btrim(p_reason), '') = '' or coalesce(btrim(p_actor), '') = '' then raise exception 'reversal_actor_and_reason_required'; end if;
  if coalesce(btrim(p_idempotency_key), '') = '' then raise exception 'idempotency_key_required'; end if;
  select * into v_entry from public.credit_ledger where id = p_entry;
  if not found then raise exception 'ledger_entry_not_found'; end if;
  if v_entry.entry_type in ('reversal', 'refund', 'opening_balance') then raise exception 'entry_not_reversible'; end if;
  perform 1 from public.credit_accounts where workspace_id = v_entry.workspace_id for update;
  if exists (select 1 from public.credit_ledger where reverses_entry_id = p_entry and idempotency_key <> 'reverse:' || p_idempotency_key) then
    raise exception 'entry_already_reversed';
  end if;
  if v_entry.external_reference is not null and exists (
       select 1 from public.credit_ledger where entry_type = 'refund' and provider = v_entry.provider
          and metadata ->> 'refunds' = v_entry.external_reference) then
    raise exception 'entry_partially_refunded';
  end if;
  v_result := public.apply_credit_mutation(v_entry.workspace_id, 'reversal', -v_entry.quantity, 'reverse:' || p_idempotency_key,
    p_actor, v_entry.shop_id, v_entry.provider, v_entry.external_reference, p_reason,
    jsonb_build_object('reversed_type', v_entry.entry_type), p_entry);
  if v_entry.entry_type in ('purchase', 'subscription_grant') then
    update public.provider_purchases set review_status = 'reversed', updated_at = now() where ledger_entry_id = p_entry;
  end if;
  return v_result;
end;
$$;

-- A provider refund of a credited purchase: removes at most what it granted.
create or replace function public.refund_purchase(
  p_provider text, p_external_id text, p_refund_reference text, p_quantity integer, p_actor text, p_reason text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pp public.provider_purchases%rowtype;
  v_key text := 'refund:' || p_provider || ':' || p_refund_reference;
  v_granted integer;
  v_refunded integer;
  v_result jsonb;
begin
  if coalesce(p_quantity, 0) <= 0 then raise exception 'refund_quantity_required'; end if;
  if coalesce(btrim(p_refund_reference), '') = '' then raise exception 'refund_reference_required'; end if;
  select * into v_pp from public.provider_purchases where provider = p_provider and external_id = p_external_id for update;
  if not found or v_pp.ledger_entry_id is null then raise exception 'purchase_not_credited'; end if;
  perform 1 from public.credit_accounts where workspace_id = v_pp.workspace_id for update;
  if exists (select 1 from public.credit_ledger where idempotency_key = v_key) then
    return public.apply_credit_mutation(v_pp.workspace_id, 'refund', -p_quantity, v_key, p_actor, v_pp.shop_id,
      p_provider, p_refund_reference, p_reason, jsonb_build_object('refunds', p_external_id));
  end if;
  if v_pp.review_status = 'reversed' then raise exception 'purchase_reversed'; end if;
  select quantity into v_granted from public.credit_ledger where id = v_pp.ledger_entry_id;
  select coalesce(-sum(quantity), 0) into v_refunded from public.credit_ledger
   where entry_type = 'refund' and provider = p_provider and metadata ->> 'refunds' = p_external_id;
  if v_refunded + p_quantity > v_granted then raise exception 'refund_exceeds_purchase'; end if;
  v_result := public.apply_credit_mutation(v_pp.workspace_id, 'refund', -p_quantity, v_key, p_actor, v_pp.shop_id,
    p_provider, p_refund_reference, p_reason, jsonb_build_object('refunds', p_external_id));
  if v_refunded + p_quantity = v_granted then
    update public.provider_purchases set review_status = 'refunded', updated_at = now() where id = v_pp.id;
  end if;
  return v_result;
end;
$$;

create or replace function public.revoke_credit_entitlement(p_entitlement uuid, p_actor text, p_reason text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  if coalesce(btrim(p_reason), '') = '' or coalesce(btrim(p_actor), '') = '' then raise exception 'revocation_actor_and_reason_required'; end if;
  update public.credit_entitlements set revoked_at = now(), revoked_by = p_actor, revoke_reason = p_reason
   where id = p_entitlement and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- Compare-and-set on the reconciliation cursor, so concurrent runs never move it backwards.
create or replace function public.save_billing_cursor(
  p_shop uuid, p_expected text, p_cursor text, p_completed boolean, p_error text default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  insert into public.billing_sync_state (shop_id, last_started_at) values (p_shop, now()) on conflict do nothing;
  update public.billing_sync_state
     set cursor = p_cursor, last_error = left(p_error, 500), updated_at = now(),
         last_completed_at = case when p_completed then now() else last_completed_at end
   where shop_id = p_shop and cursor is not distinct from p_expected;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ── Brief generation debits through the ledger ──────────────────────────────

drop function if exists public.commit_brief_generation(text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb);

create or replace function public.commit_brief_generation(
  p_workspace uuid, p_user_id text, p_request_id uuid, p_request_hash text, p_campaign_id uuid,
  p_campaign jsonb, p_copy jsonb, p_context jsonb, p_response jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ws jsonb := public.workspace_for_actor(p_workspace, p_user_id);
  c public.campaigns%rowtype;
  prior public.brief_generation_receipts%rowtype;
  v_balance integer;
  v_unlimited boolean;
  v_campaign_id uuid;
  v_version_id uuid;
  v_attempt integer;
  v_result jsonb;
begin
  -- Serialise this workspace's generations on its credit account.
  select balance into v_balance from public.credit_accounts where workspace_id = p_workspace for update;

  select * into prior from public.brief_generation_receipts where clerk_user_id = p_user_id and request_id = p_request_id;
  if found then
    if prior.request_hash <> p_request_hash then raise exception 'idempotency_conflict'; end if;
    return prior.response;
  end if;

  if v_ws ->> 'status' <> 'active' then raise exception 'workspace_inactive'; end if;
  v_unlimited := public.workspace_unlimited_until(p_workspace) is not null;

  if p_campaign_id is not null then
    -- Campaigns stay creator-only, inside their workspace.
    select * into c from public.campaigns
     where id = p_campaign_id and clerk_user_id = p_user_id and workspace_id = p_workspace for update;
    if not found then raise exception 'invalid_regeneration'; end if;
    if c.product_name is distinct from p_campaign->>'product_name'
       or c.product_description is distinct from p_campaign->>'product_description'
       or c.campaign_goal is distinct from p_campaign->>'campaign_goal'
       or c.product_price is distinct from p_campaign->>'product_price' then
      raise exception 'regeneration_product_changed';
    end if;
    select count(*) + 1 into v_attempt from public.campaign_brief_versions cbv where cbv.campaign_id = c.id and cbv.clerk_user_id = p_user_id;
    if v_attempt < 2 or v_attempt > 4 then raise exception 'regeneration_limit'; end if;
    v_campaign_id := c.id;
  else
    if not v_unlimited and v_balance < 1 then raise exception 'no_credits'; end if;

    insert into public.campaigns (
      clerk_user_id, workspace_id, status, brand_name, product_name, product_description, target_audience,
      campaign_goal, tone_preference, platform, media_url, product_price, headline, primary_text,
      description, cta, copywriter_note, brief_data
    ) values (
      p_user_id, p_workspace, 'draft', p_campaign->>'brand_name', p_campaign->>'product_name', p_campaign->>'product_description',
      p_campaign->>'target_audience', p_campaign->>'campaign_goal', p_campaign->>'tone_preference', p_campaign->>'platform',
      p_campaign->>'media_url', p_campaign->>'product_price', p_copy->>'headline', p_copy->>'primary_text',
      p_copy->>'description', p_copy->>'cta', p_copy->>'copywriter_note', p_context
    ) returning id into v_campaign_id;
    v_attempt := 1;

    if not v_unlimited then
      v_balance := (public.apply_credit_mutation(p_workspace, 'consumption', -1, 'brief:' || p_request_id::text, p_user_id,
        public.current_shop_of(p_workspace), null, null, 'brief_generated',
        jsonb_build_object('campaign_id', v_campaign_id)) ->> 'balance')::integer;
    end if;
  end if;

  insert into public.campaign_brief_versions (
    campaign_id, clerk_user_id, attempt_number, is_selected,
    headline, primary_text, description, cta, copywriter_note, brief_data
  ) values (
    v_campaign_id, p_user_id, v_attempt, v_attempt = 1,
    p_copy->>'headline', p_copy->>'primary_text', p_copy->>'description',
    p_copy->>'cta', p_copy->>'copywriter_note', p_context
  ) returning id into v_version_id;

  v_result := p_response || jsonb_build_object(
    'campaignId', v_campaign_id, 'versionId', v_version_id, 'attemptNumber', v_attempt,
    'credits_balance', v_balance, 'is_unlimited', v_unlimited);

  insert into public.brief_generation_receipts (clerk_user_id, request_id, request_hash, response)
  values (p_user_id, p_request_id, p_request_hash, v_result);
  return v_result;
end;
$$;

-- ── Legacy opening balances (used by task 6) ─────────────────────────────────

-- What the legacy records explain for one user_integrations row. Read-only.
create or replace function public.legacy_credit_reconciliation(p_legacy_row uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  u public.user_integrations%rowtype;
  v_balance integer;
  v_free integer;
  v_paid integer;
  v_adjusted integer;
  v_used integer;
  v_explained integer;
begin
  select * into u from public.user_integrations where id = p_legacy_row;
  if not found then raise exception 'legacy_row_not_found'; end if;
  v_balance := coalesce((to_jsonb(u) ->> 'credits')::integer, u.credits_balance, 0);
  v_free := case when coalesce((to_jsonb(u) ->> 'free_credit_used')::boolean, false) then 1 else 0 end;
  select coalesce(sum(credits_granted), 0) into v_paid from public.payments
   where clerk_user_id = u.clerk_user_id and status = 'success';
  select coalesce(sum(delta), 0) into v_adjusted from public.credit_adjustments where clerk_user_id = u.clerk_user_id;
  select coalesce(sum(credits_used), 0) into v_used from public.credit_usage where clerk_user_id = u.clerk_user_id;
  v_explained := v_free + v_paid + v_adjusted - v_used;
  return jsonb_build_object(
    'legacy_row_id', u.id, 'clerk_user_id', u.clerk_user_id,
    'legacy_balance', v_balance,
    'credits_column', (to_jsonb(u) ->> 'credits')::integer, 'credits_balance_column', u.credits_balance,
    'free_credit_used', v_free = 1, 'payments_granted', v_paid, 'adjustments', v_adjusted, 'usage', v_used,
    'explained_balance', v_explained, 'difference', v_balance - v_explained,
    'credits_total_purchased', u.credits_total_purchased,
    'unlimited_until', u.credits_unlimited_until);
end;
$$;

create or replace function public.legacy_credit_reconciliation_report()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.legacy_credit_reconciliation(id) order by created_at), '[]'::jsonb)
    from public.user_integrations;
$$;

-- Carries one legacy balance into the workspace created for that legacy row,
-- exactly once. The opening entry equals the legacy balance; nothing is
-- invented. A balance the records do not explain goes to credit_opening_reviews.
-- user_integrations is left untouched.
create or replace function public.open_legacy_credit_balance(p_workspace uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ws public.workspaces%rowtype;
  v_owner text;
  v_rec jsonb;
  v_result jsonb;
  v_review boolean;
begin
  select * into v_ws from public.workspaces where id = p_workspace;
  if not found or v_ws.legacy_user_integration_id is null then raise exception 'not_a_legacy_workspace'; end if;
  select clerk_user_id into v_owner from public.user_integrations where id = v_ws.legacy_user_integration_id;
  if v_owner is null or v_owner <> v_ws.owner_clerk_user_id then raise exception 'legacy_owner_mismatch'; end if;

  v_rec := public.legacy_credit_reconciliation(v_ws.legacy_user_integration_id);
  if (v_rec ->> 'legacy_balance')::integer < 0 then raise exception 'negative_legacy_balance'; end if;
  v_result := public.apply_credit_mutation(p_workspace, 'opening_balance', (v_rec ->> 'legacy_balance')::integer,
    'opening:' || v_ws.legacy_user_integration_id::text, 'migration', null, 'legacy', v_ws.legacy_user_integration_id::text,
    'legacy_opening_balance', v_rec);

  if v_result ->> 'outcome' = 'applied' then
    if (v_rec ->> 'unlimited_until')::timestamptz > now() then
      insert into public.credit_entitlements (workspace_id, kind, starts_at, ends_at, provider, external_reference,
        idempotency_key, actor_clerk_user_id, reason)
      values (p_workspace, 'unlimited', now(), (v_rec ->> 'unlimited_until')::timestamptz, 'legacy',
        v_ws.legacy_user_integration_id::text, 'opening-unlimited:' || v_ws.legacy_user_integration_id::text, 'migration',
        'legacy_unlimited_access');
    end if;
    if (v_rec ->> 'difference')::integer <> 0
       or (v_rec ->> 'credits_column') is distinct from (v_rec ->> 'credits_balance_column') then
      insert into public.credit_opening_reviews (workspace_id, legacy_user_integration_id, clerk_user_id, legacy_balance,
        explained_balance, difference, components)
      values (p_workspace, v_ws.legacy_user_integration_id, v_owner, (v_rec ->> 'legacy_balance')::integer,
        (v_rec ->> 'explained_balance')::integer, (v_rec ->> 'difference')::integer, v_rec)
      on conflict (legacy_user_integration_id) do nothing;
    end if;
  end if;
  v_review := exists (select 1 from public.credit_opening_reviews where legacy_user_integration_id = v_ws.legacy_user_integration_id);
  return v_result || jsonb_build_object('reconciliation', v_rec, 'needs_review', v_review);
end;
$$;

-- ── Legacy user-keyed credit functions: retired ─────────────────────────────
-- They changed user_integrations balances outside the ledger. Each now refuses.

create or replace function public.add_user_credits(p_user_id text, p_credits integer, p_purchased integer default 0)
returns integer language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'credit_function_retired: use the workspace credit ledger'; end;
$$;
create or replace function public.increment_credits(p_user_id text, p_credits integer, p_total integer)
returns void language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'credit_function_retired: use the workspace credit ledger'; end;
$$;
create or replace function public.grant_free_credit(p_user_id text)
returns boolean language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'credit_function_retired: use grant_workspace_free_credit'; end;
$$;
create or replace function public.apply_credit_adjustment(p_idempotency_key text, p_user_id text, p_delta integer, p_reason text, p_evidence jsonb default '{}'::jsonb)
returns text language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'credit_function_retired: use adjust_workspace_credits'; end;
$$;

-- ── Access ───────────────────────────────────────────────────────────────────

alter table public.credit_ledger enable row level security;
alter table public.credit_entitlements enable row level security;
alter table public.purchase_intents enable row level security;
alter table public.provider_purchases enable row level security;
alter table public.billing_sync_state enable row level security;
alter table public.credit_opening_reviews enable row level security;

revoke all on table public.credit_ledger, public.credit_entitlements, public.purchase_intents, public.provider_purchases,
  public.billing_sync_state, public.credit_opening_reviews from public, anon, authenticated, service_role;
grant select on table public.credit_ledger, public.credit_entitlements, public.purchase_intents, public.provider_purchases,
  public.billing_sync_state, public.credit_opening_reviews to service_role;

revoke all on function
  public.guard_credit_account(), public.guard_credit_entitlement(),
  public.apply_credit_mutation(uuid, text, integer, text, text, uuid, text, text, text, jsonb, bigint),
  public.workspace_unlimited_until(uuid), public.workspace_credit_status(uuid, text), public.current_shop_of(uuid),
  public.create_purchase_intent(uuid, text, text, text, text, integer, integer, numeric, text, text),
  public.attach_intent_charge(uuid, text), public.fail_purchase_intent(uuid, text),
  public.settle_purchase(text, text, text, uuid, uuid, uuid, text, text, integer, integer, text, text, boolean, boolean, numeric, text, timestamptz, jsonb),
  public.grant_intent_purchase(text, text, text, text, boolean, boolean, numeric, text, timestamptz, jsonb),
  public.record_shop_purchase(uuid, text, text, text, integer, text, boolean, boolean, numeric, text, timestamptz, jsonb),
  public.grant_workspace_free_credit(uuid, text), public.adjust_workspace_credits(uuid, integer, text, text, text, jsonb),
  public.reverse_credit_entry(bigint, text, text, text), public.refund_purchase(text, text, text, integer, text, text),
  public.revoke_credit_entitlement(uuid, text, text), public.save_billing_cursor(uuid, text, text, boolean, text),
  public.commit_brief_generation(uuid, text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb),
  public.legacy_credit_reconciliation(uuid), public.legacy_credit_reconciliation_report(),
  public.open_legacy_credit_balance(uuid),
  public.add_user_credits(text, integer, integer), public.increment_credits(text, integer, integer),
  public.grant_free_credit(text), public.apply_credit_adjustment(text, text, integer, text, jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  public.workspace_credit_status(uuid, text),
  public.create_purchase_intent(uuid, text, text, text, text, integer, integer, numeric, text, text),
  public.attach_intent_charge(uuid, text), public.fail_purchase_intent(uuid, text),
  public.grant_intent_purchase(text, text, text, text, boolean, boolean, numeric, text, timestamptz, jsonb),
  public.record_shop_purchase(uuid, text, text, text, integer, text, boolean, boolean, numeric, text, timestamptz, jsonb),
  public.grant_workspace_free_credit(uuid, text), public.adjust_workspace_credits(uuid, integer, text, text, text, jsonb),
  public.reverse_credit_entry(bigint, text, text, text), public.refund_purchase(text, text, text, integer, text, text),
  public.revoke_credit_entitlement(uuid, text, text), public.save_billing_cursor(uuid, text, text, boolean, text),
  public.commit_brief_generation(uuid, text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb),
  public.legacy_credit_reconciliation_report()
to service_role;
