-- DATA-02 (Phase S1): an auditable, idempotent way to correct credit balances.
-- Each correction has a unique key, its reason and its evidence, and is applied
-- at most once. delta may be 0 to record a reviewed decision with no balance
-- change. The single authoritative ledger arrives in Phase 1.
create table if not exists public.credit_adjustments (
  idempotency_key text primary key,
  clerk_user_id   text not null,
  delta           integer not null,
  reason          text not null,
  evidence        jsonb not null default '{}'::jsonb,
  balance_before  integer not null,
  balance_after   integer not null,
  applied_at      timestamptz not null default now()
);
create index if not exists credit_adjustments_user_idx on public.credit_adjustments (clerk_user_id);
alter table public.credit_adjustments enable row level security;
revoke all on table public.credit_adjustments from public, anon, authenticated;
grant select on table public.credit_adjustments to service_role;

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

revoke all on function public.apply_credit_adjustment(text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_credit_adjustment(text, text, integer, text, jsonb) to service_role;
