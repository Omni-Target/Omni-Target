-- Rollback for 0007_campaign_brief_versions.
--
-- Safe reversal: campaign_brief_versions is introduced by 0007, so dropping it
-- only discards data created after this migration. The campaigns indexes are
-- pure performance aids and carry no data.

drop index if exists public.idx_campaigns_user_created;
drop index if exists public.idx_campaigns_user_status;
drop index if exists public.idx_cbv_user_created;
drop index if exists public.idx_cbv_campaign_id;
drop table if exists public.campaign_brief_versions;
