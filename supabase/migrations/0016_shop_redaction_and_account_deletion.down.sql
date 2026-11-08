-- Roll back 0016: removes the functions only. Redacted data is not restored.
drop function if exists public.redact_shop_data(text, boolean);
drop function if exists public.delete_user_data(text);
