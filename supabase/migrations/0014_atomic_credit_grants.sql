-- DATA-02 (interim, Phase S1): every credit grant becomes one atomic operation.
--
-- The schema has two balance columns. commit_brief_generation reads `credits`
-- first and writes both, but increment_credits only wrote `credits_balance`
-- (so Stripe/Paystack grants were invisible and were overwritten by the next
-- debit), addCreditsToUser was a read-modify-write that could lose concurrent
-- grants, and the free credit SET the balance to 1 instead of adding to it.
--
-- These functions use the same definition of the balance as
-- commit_brief_generation, take the row lock, and keep both columns equal.
-- No balance is changed by this migration. A ledger replaces this in Phase 1.

create or replace function public.add_user_credits(
  p_user_id text,
  p_credits integer,
  p_purchased integer default 0
) returns integer language plpgsql set search_path = public as $$
declare
  u public.user_integrations%rowtype;
  new_balance integer;
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'invalid_credit_amount';
  end if;
  select * into u from public.user_integrations where clerk_user_id = p_user_id for update;
  if not found then raise exception 'integration_not_found'; end if;

  new_balance := coalesce((to_jsonb(u)->>'credits')::integer, u.credits_balance, 0) + p_credits;
  update public.user_integrations
     set credits_balance = new_balance,
         credits_total_purchased = coalesce(credits_total_purchased, 0) + coalesce(p_purchased, 0)
   where clerk_user_id = p_user_id;
  if to_jsonb(u) ? 'credits' then
    execute 'update public.user_integrations set credits = $1 where clerk_user_id = $2'
      using new_balance, p_user_id;
  end if;
  return new_balance;
end;
$$;

-- Grants the one free install credit at most once, on top of the current
-- balance. Returns true only for the call that granted it.
create or replace function public.grant_free_credit(p_user_id text)
returns boolean language plpgsql set search_path = public as $$
declare
  u public.user_integrations%rowtype;
begin
  select * into u from public.user_integrations where clerk_user_id = p_user_id for update;
  if not found or coalesce((to_jsonb(u)->>'free_credit_used')::boolean, true) then
    return false;
  end if;
  perform public.add_user_credits(p_user_id, 1, 0);
  execute 'update public.user_integrations set free_credit_used = true where clerk_user_id = $1'
    using p_user_id;
  return true;
end;
$$;

-- Same signature, so deployed code calling it also keeps both columns in step.
create or replace function public.increment_credits(
  p_user_id text,
  p_credits integer,
  p_total integer
) returns void language plpgsql set search_path = public as $$
begin
  perform public.add_user_credits(p_user_id, p_credits, p_total);
end;
$$;

revoke all on function public.add_user_credits(text, integer, integer) from public, anon, authenticated;
revoke all on function public.grant_free_credit(text) from public, anon, authenticated;
revoke all on function public.increment_credits(text, integer, integer) from public, anon, authenticated;
grant execute on function public.add_user_credits(text, integer, integer) to service_role;
grant execute on function public.grant_free_credit(text) to service_role;
grant execute on function public.increment_credits(text, integer, integer) to service_role;
