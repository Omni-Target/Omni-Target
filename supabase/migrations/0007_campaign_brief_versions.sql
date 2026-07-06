-- Brief versioning + history support (perf/reliability initiative, Phase 1)
--
-- Today a generated brief lives only in client state: a refresh loses work the
-- user paid a credit for, regeneration attempts overwrite each other, and there
-- is no history to revisit. This migration adds durable persistence:
--
--   * campaign_brief_versions — one row per generation attempt (the initial
--     brief + up to 3 free regenerations) linked to a campaigns row. Exactly one
--     row per campaign carries is_selected = true (the variation the user kept).
--   * indexes on campaigns for the per-user brief lists this unlocks (history
--     list + getUserCampaigns), which today do a full table scan.
--
-- Idempotent (`if not exists`) and RLS-enabled with no policies, matching every
-- other table (the app reaches these only via the service-role key, which
-- bypasses RLS). Reversible via the companion 0007_*.down.sql.

-- One row per brief generation attempt ----------------------------------------
create table if not exists public.campaign_brief_versions (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.campaigns(id) on delete cascade,
  clerk_user_id   text not null,
  attempt_number  integer not null default 1,
  headline        text,
  primary_text    text,
  description     text,
  cta             text,
  copywriter_note text,
  is_selected     boolean not null default false,
  created_at      timestamptz default now()
);

-- Load all attempts for a campaign (compare view + alternative attempts).
create index if not exists idx_cbv_campaign_id
  on public.campaign_brief_versions using btree (campaign_id);

-- Per-user recency (feeds history/list ordering and authz-scoped reads).
create index if not exists idx_cbv_user_created
  on public.campaign_brief_versions using btree (clerk_user_id, created_at desc);

alter table public.campaign_brief_versions enable row level security;

-- campaigns indexes for the per-user lists this unlocks -----------------------
-- getUserCampaigns filters (clerk_user_id, status); brief history orders by
-- (clerk_user_id, created_at desc). Both are full scans without these.
create index if not exists idx_campaigns_user_status
  on public.campaigns using btree (clerk_user_id, status);

create index if not exists idx_campaigns_user_created
  on public.campaigns using btree (clerk_user_id, created_at desc);
