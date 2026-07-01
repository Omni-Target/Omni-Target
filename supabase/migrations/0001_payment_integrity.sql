-- Payment integrity: idempotency + atomic credit grants
--
-- Apply this migration to the Supabase project before (or together with) the
-- Wave 1 deploy. The application code (src/lib/db.ts, src/lib/grant-credits.ts)
-- prefers these objects and falls back to a non-atomic path with a loud warning
-- if they are missing, so deploy ordering will not break payments — but the
-- guarantees below only hold once this is applied.

-- 1. Idempotency guard ------------------------------------------------------
-- One row per payment that has had credits granted. The primary key makes a
-- concurrent second insert fail with unique_violation (23505), which the app
-- uses to skip duplicate webhook deliveries / callback replays.
create table if not exists public.processed_payments (
  payment_id   text primary key,
  processed_at timestamptz not null default now()
);

-- 2. Atomic credit increment ------------------------------------------------
-- Replaces the read-modify-write that could lose credits under concurrent
-- grants. Performs the add in a single UPDATE statement.
create or replace function public.increment_credits(
  p_user_id text,
  p_credits integer,
  p_total   integer
)
returns void
language sql
as $$
  update public.user_integrations
  set credits_balance         = coalesce(credits_balance, 0) + p_credits,
      credits_total_purchased = coalesce(credits_total_purchased, 0) + p_total
  where clerk_user_id = p_user_id;
$$;
