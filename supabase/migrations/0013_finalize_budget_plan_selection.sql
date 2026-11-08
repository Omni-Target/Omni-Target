-- S0.6 (BIZ-01/03/04): the merchant's maximum test budget is a user selection.
--
-- finalize_brief_version (0009) keeps every stored brief_data key immutable
-- except the selection keys, so generation evidence cannot be rewritten by the
-- client. The new brief_data.budget_plan (computed server-side from the
-- merchant's own cap) is a selection like selectedDuration, but it was not on
-- that list: the first saved plan froze, and every later edit was silently
-- replaced by it. This is the 0009 function with 'budget_plan' added to the
-- updatable selections; nothing else changes.
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
    context := context || (v.brief_data - 'selectedCta' - 'selectedDuration' - 'selectedStrategyIndex' - 'selectedIntlStrategyIndex' - 'budget_plan');
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
