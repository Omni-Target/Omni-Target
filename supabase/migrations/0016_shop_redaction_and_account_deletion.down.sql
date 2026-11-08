-- Roll back 0016: removes the functions and the uninstall timestamp. Redacted
-- or deleted data is not restored.
drop function if exists public.disconnect_shop_installation(text);
drop function if exists public.redact_shop_data(text);
drop function if exists public.delete_user_data(text);
drop function if exists public.normalize_shop_host(text);
alter table public.user_integrations drop column if exists shopify_uninstalled_at;
