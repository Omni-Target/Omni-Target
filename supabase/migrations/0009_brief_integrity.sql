-- Apply before deploying the matching application. No data rewrite or deletion.
-- A validated generation, its context, usage entry and credit debit commit together.
alter table public.campaign_brief_versions add column if not exists brief_data jsonb;
alter table public.campaigns add column if not exists brief_data jsonb;
create table if not exists public.brief_generation_receipts (
  clerk_user_id text not null,
  request_id uuid not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (clerk_user_id, request_id)
);
alter table public.brief_generation_receipts enable row level security;

create or replace function public.commit_brief_generation(
  p_user_id text, p_request_id uuid, p_request_hash text, p_campaign_id uuid,
  p_campaign jsonb, p_copy jsonb, p_context jsonb, p_response jsonb
) returns jsonb language plpgsql set search_path = public as $$
declare
  u public.user_integrations%rowtype;
  c public.campaigns%rowtype;
  prior public.brief_generation_receipts%rowtype;
  campaign_id uuid;
  version_id uuid;
  attempt integer;
  balance integer;
  unlimited boolean;
  result jsonb;
begin
  -- Serialize all commits for this user, including retries and concurrent tabs.
  select * into u from public.user_integrations where clerk_user_id = p_user_id for update;
  if not found then raise exception 'integration_not_found'; end if;
  select * into prior from public.brief_generation_receipts where clerk_user_id = p_user_id and request_id = p_request_id;
  if found then
    if prior.request_hash <> p_request_hash then raise exception 'idempotency_conflict'; end if;
    return prior.response;
  end if;
  balance := coalesce((to_jsonb(u)->>'credits')::integer, u.credits_balance, 0);
  unlimited := coalesce(u.credits_unlimited_until > now(), false);
  if p_campaign_id is not null then
    select * into c from public.campaigns where id = p_campaign_id and clerk_user_id = p_user_id for update;
    if not found then raise exception 'invalid_regeneration'; end if;
    if c.product_name is distinct from p_campaign->>'product_name'
       or c.product_description is distinct from p_campaign->>'product_description'
       or c.campaign_goal is distinct from p_campaign->>'campaign_goal'
       or c.product_price is distinct from p_campaign->>'product_price' then
      raise exception 'regeneration_product_changed';
    end if;
    select count(*) + 1 into attempt from public.campaign_brief_versions where campaign_id = c.id and clerk_user_id = p_user_id;
    if attempt < 2 or attempt > 4 then raise exception 'regeneration_limit'; end if;
    campaign_id := c.id;
  else
    if not unlimited and balance < 1 then raise exception 'no_credits'; end if;
    insert into public.campaigns (clerk_user_id, status, brand_name, product_name, product_description, target_audience,
      campaign_goal, tone_preference, platform, media_url, product_price, headline, primary_text, description, cta, copywriter_note, brief_data)
    values (p_user_id, 'draft', p_campaign->>'brand_name', p_campaign->>'product_name', p_campaign->>'product_description',
      p_campaign->>'target_audience', p_campaign->>'campaign_goal', p_campaign->>'tone_preference', p_campaign->>'platform',
      p_campaign->>'media_url', p_campaign->>'product_price', p_copy->>'headline', p_copy->>'primary_text', p_copy->>'description',
      p_copy->>'cta', p_copy->>'copywriter_note', p_context) returning id into campaign_id;
    attempt := 1;
    if not unlimited then
      balance := balance - 1;
      update public.user_integrations set credits_balance = balance where clerk_user_id = p_user_id;
      if to_jsonb(u) ? 'credits' then
        execute 'update public.user_integrations set credits = $1 where clerk_user_id = $2' using balance, p_user_id;
      end if;
      insert into public.credit_usage (clerk_user_id, credits_used, action) values (p_user_id, 1, 'brief_generated');
    end if;
  end if;
  insert into public.campaign_brief_versions (campaign_id, clerk_user_id, attempt_number, is_selected,
    headline, primary_text, description, cta, copywriter_note, brief_data)
  values (campaign_id, p_user_id, attempt, attempt = 1, p_copy->>'headline', p_copy->>'primary_text',
    p_copy->>'description', p_copy->>'cta', p_copy->>'copywriter_note', p_context) returning id into version_id;
  result := p_response || jsonb_build_object('campaignId', campaign_id, 'versionId', version_id, 'attemptNumber', attempt,
    'credits_balance', balance, 'is_unlimited', unlimited);
  insert into public.brief_generation_receipts (clerk_user_id, request_id, request_hash, response)
    values (p_user_id, p_request_id, p_request_hash, result);
  return result;
end;
$$;
revoke all on function public.commit_brief_generation(text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_brief_generation(text, uuid, text, uuid, jsonb, jsonb, jsonb, jsonb) to service_role;

-- Selection and full context save are one owner-scoped transaction.
create or replace function public.finalize_brief_version(
  p_user_id text, p_campaign_id uuid, p_version_id uuid, p_context jsonb, p_copy jsonb, p_status text
) returns void language plpgsql set search_path = public as $$
declare
  v public.campaign_brief_versions%rowtype;
  context jsonb;
begin
  perform 1 from public.campaigns where id = p_campaign_id and clerk_user_id = p_user_id for update;
  if not found then raise exception 'campaign_not_found'; end if;
  select * into v from public.campaign_brief_versions where id = p_version_id and campaign_id = p_campaign_id and clerk_user_id = p_user_id;
  if not found then raise exception 'version_not_found'; end if;
  -- Keep immutable generation evidence; only user selections can be updated here.
  context := coalesce(v.brief_data, '{}'::jsonb) || coalesce(p_context, '{}'::jsonb);
  if v.brief_data is not null then
    context := context || (v.brief_data - 'selectedCta' - 'selectedDuration' - 'selectedStrategyIndex' - 'selectedIntlStrategyIndex');
  end if;
  context := context || jsonb_build_object('generatedCopy', jsonb_build_object(
    'headline', v.headline, 'primaryText', v.primary_text, 'description', v.description, 'cta', v.cta, 'copywriterNote', v.copywriter_note));
  update public.campaign_brief_versions set is_selected = (id = p_version_id) where campaign_id = p_campaign_id and clerk_user_id = p_user_id;
  update public.campaign_brief_versions set brief_data = context where id = p_version_id;
  update public.campaigns set brief_data = context, headline = v.headline, primary_text = v.primary_text,
    description = v.description, cta = coalesce(context->>'selectedCta', v.cta), copywriter_note = v.copywriter_note,
    status = case when p_status = 'complete' then 'complete' else status end, updated_at = now()
    where id = p_campaign_id and clerk_user_id = p_user_id;
end;
$$;
revoke all on function public.finalize_brief_version(text, uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.finalize_brief_version(text, uuid, uuid, jsonb, jsonb, text) to service_role;
