-- Reverses 0023. Workspace attribution on these tables is discarded.
drop trigger if exists capi_events_workspace on public.capi_events;
drop trigger if exists payments_workspace on public.payments;
drop trigger if exists brief_generation_receipts_workspace on public.brief_generation_receipts;
drop trigger if exists campaign_brief_versions_workspace on public.campaign_brief_versions;
drop function if exists public.fill_capi_workspace();
drop function if exists public.fill_payment_workspace();
drop function if exists public.fill_receipt_workspace();
drop function if exists public.fill_version_workspace();
alter table public.capi_events drop column if exists workspace_id;
alter table public.credit_usage drop column if exists workspace_id;
alter table public.payments drop column if exists workspace_id;
alter table public.brief_generation_receipts drop column if exists workspace_id;
alter table public.campaign_brief_versions drop column if exists workspace_id;
