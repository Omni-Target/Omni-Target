-- Roll back 0014: restore the 0001 increment_credits and remove the new
-- functions. Roll the application back first. Balances are not touched.
create or replace function public.increment_credits(
  p_user_id text,
  p_credits integer,
  p_total integer
) returns void language sql as $$
  update public.user_integrations
  set credits_balance         = coalesce(credits_balance, 0) + p_credits,
      credits_total_purchased = coalesce(credits_total_purchased, 0) + p_total
  where clerk_user_id = p_user_id;
$$;
revoke all on function public.increment_credits(text, integer, integer) from public, anon, authenticated;
grant execute on function public.increment_credits(text, integer, integer) to service_role;

drop function if exists public.grant_free_credit(text);
drop function if exists public.add_user_credits(text, integer, integer);
