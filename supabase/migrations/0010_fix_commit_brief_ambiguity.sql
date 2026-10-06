-- 0010_fix_commit_brief_ambiguity.sql
-- Fixes ambiguous column reference "campaign_id" in commit_brief_generation PL/pgSQL function.
-- Renames PL/pgSQL variables with v_ prefix to avoid shadowing table columns.

create or replace function public.commit_brief_generation(
  p_user_id text,
  p_request_id uuid,
  p_request_hash text,
  p_campaign_id uuid,
  p_campaign jsonb,
  p_copy jsonb,
  p_context jsonb,
  p_response jsonb
) returns jsonb language plpgsql set search_path = public as $$
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
  -- Serialize all commits for this user, including retries and concurrent tabs.
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
