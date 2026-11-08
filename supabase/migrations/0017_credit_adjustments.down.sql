-- Roll back 0017. Balances already adjusted are NOT reversed, and the audit
-- trail of those adjustments is lost; export the table first.
drop function if exists public.apply_credit_adjustment(text, text, integer, text, jsonb);
drop table if exists public.credit_adjustments;
