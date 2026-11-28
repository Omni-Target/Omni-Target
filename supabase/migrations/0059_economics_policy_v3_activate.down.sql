-- Reverts 0059_economics_policy_v3_activate.sql: version 2 becomes the active policy again. Version 3 is retired and
-- keeps its approval record (recommendations recorded under it still reference it), or returns to a pending draft if
-- nothing was recorded under it.

update public.economics_policies set status = 'retired' where version = 3 and status = 'active';
update public.economics_policies
   set status = 'draft', activated_at = null, approval = 'pending', approved_at = null, approved_by = null
 where version = 3
   and not exists (select 1 from public.economics_runs where policy_version = 3)
   and not exists (select 1 from public.ad_campaign_evaluations where policy_version = 3);
update public.economics_policies set status = 'active' where version = 2
   and not exists (select 1 from public.economics_policies where status = 'active');
