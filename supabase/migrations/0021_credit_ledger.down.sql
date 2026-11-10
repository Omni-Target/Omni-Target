-- Reverses 0021. The ledger, entitlements, intents and purchase records are
-- discarded, and workspace balances lose their history. Take a backup first on
-- any database that holds real credit activity. The legacy user-keyed credit
-- functions are restored as 0014, 0017 and 0010 defined them.

drop function if exists public.legacy_credit_reconciliation_report();
drop function if exists public.open_legacy_credit_balance(uuid);
drop function if exists public.legacy_credit_reconciliation(uuid);
drop function if exists public.commit_brief_generation(uuid, text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb);
drop function if exists public.save_billing_cursor(uuid, text, text, boolean, text);
drop function if exists public.revoke_credit_entitlement(uuid, text, text);
drop function if exists public.refund_purchase(text, text, text, integer, text, text);
drop function if exists public.reverse_credit_entry(bigint, text, text, text);
drop function if exists public.adjust_workspace_credits(uuid, integer, text, text, text, jsonb);
drop function if exists public.grant_workspace_free_credit(uuid, text);
drop function if exists public.record_shop_purchase(uuid, text, text, text, integer, text, boolean, boolean, numeric, text, timestamptz, jsonb);
drop function if exists public.grant_intent_purchase(text, text, text, text, boolean, boolean, numeric, text, timestamptz, jsonb);
drop function if exists public.settle_purchase(text, text, text, uuid, uuid, uuid, text, text, integer, integer, text, text, boolean, boolean, numeric, text, timestamptz, jsonb);
drop function if exists public.fail_purchase_intent(uuid, text);
drop function if exists public.attach_intent_charge(uuid, text);
drop function if exists public.create_purchase_intent(uuid, text, text, text, text, integer, integer, numeric, text, text);
drop function if exists public.current_shop_of(uuid);
drop function if exists public.workspace_credit_status(uuid, text);
drop function if exists public.workspace_unlimited_until(uuid);
drop function if exists public.apply_credit_mutation(uuid, text, integer, text, text, uuid, text, text, text, jsonb, bigint);

drop table if exists public.credit_opening_reviews;
drop table if exists public.billing_sync_state;
drop table if exists public.provider_purchases;
drop table if exists public.purchase_intents;
drop table if exists public.credit_entitlements;
drop table if exists public.credit_ledger;
drop function if exists public.guard_credit_entitlement();

drop trigger if exists credit_accounts_guard on public.credit_accounts;
drop function if exists public.guard_credit_account();

-- Legacy credit functions (0014).
create or replace function public.add_user_credits(
  p_user_id text,
  p_credits integer,
  p_purchased integer default 0
) returns integer language plpgsql set search_path = public as $$
declare
  u public.user_integrations%rowtype;
  new_balance integer;
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'invalid_credit_amount';
  end if;
  select * into u from public.user_integrations where clerk_user_id = p_user_id for update;
  if not found then raise exception 'integration_not_found'; end if;

  new_balance := coalesce((to_jsonb(u)->>'credits')::integer, u.credits_balance, 0) + p_credits;
  update public.user_integrations
     set credits_balance = new_balance,
         credits_total_purchased = coalesce(credits_total_purchased, 0) + coalesce(p_purchased, 0)
   where clerk_user_id = p_user_id;
  if to_jsonb(u) ? 'credits' then
    execute 'update public.user_integrations set credits = $1 where clerk_user_id = $2'
      using new_balance, p_user_id;
  end if;
  return new_balance;
end;
$$;

create or replace function public.grant_free_credit(p_user_id text)
returns boolean language plpgsql set search_path = public as $$
declare
  u public.user_integrations%rowtype;
begin
  select * into u from public.user_integrations where clerk_user_id = p_user_id for update;
  if not found or coalesce((to_jsonb(u)->>'free_credit_used')::boolean, true) then
    return false;
  end if;
  perform public.add_user_credits(p_user_id, 1, 0);
  execute 'update public.user_integrations set free_credit_used = true where clerk_user_id = $1'
    using p_user_id;
  return true;
end;
$$;

create or replace function public.increment_credits(
  p_user_id text,
  p_credits integer,
  p_total integer
) returns void language plpgsql set search_path = public as $$
begin
  perform public.add_user_credits(p_user_id, p_credits, p_total);
end;
$$;

-- Legacy adjustment function (0017).
create or replace function public.apply_credit_adjustment(
  p_idempotency_key text,
  p_user_id text,
  p_delta integer,
  p_reason text,
  p_evidence jsonb default '{}'::jsonb
) returns text language plpgsql set search_path = public as $$
declare
  u public.user_integrations%rowtype;
  before_balance integer;
  after_balance integer;
begin
  if coalesce(trim(p_idempotency_key), '') = '' or coalesce(trim(p_reason), '') = '' then
    raise exception 'adjustment_key_and_reason_required';
  end if;
  select * into u from public.user_integrations where clerk_user_id = p_user_id for update;
  if not found then raise exception 'integration_not_found'; end if;
  if exists (select 1 from public.credit_adjustments where idempotency_key = p_idempotency_key) then
    return 'already_applied';
  end if;

  before_balance := coalesce((to_jsonb(u)->>'credits')::integer, u.credits_balance, 0);
  after_balance := before_balance + p_delta;
  if after_balance < 0 then raise exception 'adjustment_would_make_balance_negative'; end if;

  update public.user_integrations set credits_balance = after_balance where clerk_user_id = p_user_id;
  if to_jsonb(u) ? 'credits' then
    execute 'update public.user_integrations set credits = $1 where clerk_user_id = $2' using after_balance, p_user_id;
  end if;
  insert into public.credit_adjustments (idempotency_key, clerk_user_id, delta, reason, evidence, balance_before, balance_after)
  values (p_idempotency_key, p_user_id, p_delta, p_reason, p_evidence, before_balance, after_balance);
  return 'applied';
end;
$$;

-- User-keyed brief commit (0009, as fixed by 0010).
create or replace function public.commit_brief_generation(p_user_id text, p_request_id uuid, p_request_hash text, p_campaign_id uuid, p_campaign jsonb, p_copy jsonb, p_context jsonb, p_response jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  u public.user_integrations%rowtype;
  c public.campaigns%rowtype;
  prior public.brief_generation_receipts%rowtype;
  v_campaign_id uuid;
  v_version_id uuid;
  v_attempt integer;
  v_balance integer;
  v_unlimited boolean;
  v_result jsonb;
begin
  select * into u from public.user_integrations where clerk_user_id = p_user_id for update;
  if not found then raise exception 'integration_not_found'; end if;

  select * into prior from public.brief_generation_receipts where clerk_user_id = p_user_id and request_id = p_request_id;
  if found then
    if prior.request_hash <> p_request_hash then raise exception 'idempotency_conflict'; end if;
    return prior.response;
  end if;

  v_balance := coalesce((to_jsonb(u)->>'credits')::integer, u.credits_balance, 0);
  v_unlimited := coalesce(u.credits_unlimited_until > now(), false);

  if p_campaign_id is not null then
    select * into c from public.campaigns where id = p_campaign_id and clerk_user_id = p_user_id for update;
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
      clerk_user_id, status, brand_name, product_name, product_description, target_audience,
      campaign_goal, tone_preference, platform, media_url, product_price, headline, primary_text,
      description, cta, copywriter_note, brief_data
    )
    values (
      p_user_id, 'draft', p_campaign->>'brand_name', p_campaign->>'product_name', p_campaign->>'product_description',
      p_campaign->>'target_audience', p_campaign->>'campaign_goal', p_campaign->>'tone_preference', p_campaign->>'platform',
      p_campaign->>'media_url', p_campaign->>'product_price', p_copy->>'headline', p_copy->>'primary_text',
      p_copy->>'description', p_copy->>'cta', p_copy->>'copywriter_note', p_context
    ) returning id into v_campaign_id;

    v_attempt := 1;

    if not v_unlimited then
      v_balance := v_balance - 1;
      update public.user_integrations set credits_balance = v_balance where clerk_user_id = p_user_id;
      if to_jsonb(u) ? 'credits' then
        execute 'update public.user_integrations set credits = $1 where clerk_user_id = $2' using v_balance, p_user_id;
      end if;
      insert into public.credit_usage (clerk_user_id, credits_used, action) values (p_user_id, 1, 'brief_generated');
    end if;
  end if;

  insert into public.campaign_brief_versions (
    campaign_id, clerk_user_id, attempt_number, is_selected,
    headline, primary_text, description, cta, copywriter_note, brief_data
  )
  values (
    v_campaign_id, p_user_id, v_attempt, v_attempt = 1,
    p_copy->>'headline', p_copy->>'primary_text', p_copy->>'description',
    p_copy->>'cta', p_copy->>'copywriter_note', p_context
  ) returning id into v_version_id;

  v_result := p_response || jsonb_build_object(
    'campaignId', v_campaign_id,
    'versionId', v_version_id,
    'attemptNumber', v_attempt,
    'credits_balance', v_balance,
    'is_unlimited', v_unlimited
  );

  insert into public.brief_generation_receipts (clerk_user_id, request_id, request_hash, response)
    values (p_user_id, p_request_id, p_request_hash, v_result);

  return v_result;
end;
$$;

revoke all on function public.add_user_credits(text, integer, integer) from public, anon, authenticated;
revoke all on function public.grant_free_credit(text) from public, anon, authenticated;
revoke all on function public.increment_credits(text, integer, integer) from public, anon, authenticated;
revoke all on function public.apply_credit_adjustment(text, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.commit_brief_generation(text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.add_user_credits(text, integer, integer) to service_role;
grant execute on function public.grant_free_credit(text) to service_role;
grant execute on function public.increment_credits(text, integer, integer) to service_role;
grant execute on function public.apply_credit_adjustment(text, text, integer, text, jsonb) to service_role;
grant execute on function public.commit_brief_generation(text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb) to service_role;
