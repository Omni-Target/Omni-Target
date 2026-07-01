-- Backfill two tables that predate the migration system
--
-- email_log and exchange_rate_cache were created ad-hoc in the dev database
-- before migrations existed, so 0001-0005 never captured them and they were
-- missing from production. This migration reproduces their exact dev schema so
-- dev and prod match. It is idempotent: `if not exists` makes it a no-op on the
-- dev database (where the tables already exist) while creating them on prod.
-- RLS is enabled with no policies, matching every other table (the app reaches
-- them only via the service-role key, which bypasses RLS).

-- email_log: one row per transactional email sent (used for nudge dedupe) -----
create table if not exists public.email_log (
  id       uuid primary key default gen_random_uuid(),
  user_id  text,
  template text,
  sent_at  timestamptz default now()
);

create index if not exists idx_email_log_user_template
  on public.email_log using btree (user_id, template);

alter table public.email_log enable row level security;

-- exchange_rate_cache: a single-row cache of FX rates (id pinned to 1) ---------
create table if not exists public.exchange_rate_cache (
  id         integer primary key default 1,
  rates      jsonb not null,
  fetched_at timestamptz default now(),
  constraint one_row check (id = 1)
);

alter table public.exchange_rate_cache enable row level security;
