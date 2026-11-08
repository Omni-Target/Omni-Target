-- SEC-09 (Phase S1): three separate workflows, each one transaction.
--
--   app/uninstalled  disconnect_shop_installation  operational; keeps data
--   shop/redact      redact_shop_data              privacy; deletes Shopify data
--   account deletion delete_user_data              user-initiated; one account
--
-- Retained after shop/redact: the Omnitarget account row with its credit
-- balance, and payment rows (amount, currency, date, Shopify charge id) as
-- accounting records. Generated campaign content is NOT retained.
-- Retained after account deletion: payment rows only, irreversibly detached
-- from the user. Unused credits are forfeited.

alter table public.user_integrations add column if not exists shopify_uninstalled_at timestamptz;

create or replace function public.normalize_shop_host(p_value text)
returns text language sql immutable set search_path = public as $$
  select nullif(regexp_replace(regexp_replace(lower(trim(coalesce(p_value, ''))), '^https?://', ''), '/$', ''), '');
$$;

-- Shopify says the app is gone: revoke credentials and stop syncing. Everything
-- else waits for shop/redact, so a quick reinstall loses nothing. A row with no
-- token is skipped by every sync path; there is no job queue to cancel yet.
create or replace function public.disconnect_shop_installation(p_shop text)
returns integer language plpgsql set search_path = public as $$
declare
  shop text := public.normalize_shop_host(p_shop);
  users text[];
  assignments text;
begin
  select coalesce(array_agg(clerk_user_id), '{}') into users
    from public.user_integrations
   where shop in (public.normalize_shop_host(shopify_store_url), public.normalize_shop_host(shop_domain));
  if shop is null or cardinality(users) = 0 then return 0; end if;

  select string_agg(format('%I = null', column_name), ', ') into assignments
    from information_schema.columns
   where table_schema = 'public' and table_name = 'user_integrations'
     and column_name = any(array['shopify_access_token', 'access_token', 'shopify_refresh_token',
       'refresh_token', 'shopify_token_expires_at', 'token_expires_at', 'shopify_webhook_id']);
  execute format('update public.user_integrations set %s, shopify_uninstalled_at = now() where clerk_user_id = any($1)', assignments)
    using users;
  delete from public.shopify_refresh_locks where user_id = any(users);
  return cardinality(users);
end;
$$;

-- Privacy erasure of one shop's data, for every account linked to it. Meta
-- connections belong to the Omnitarget account and go with account deletion.
create or replace function public.redact_shop_data(p_shop text)
returns integer language plpgsql set search_path = public as $$
declare
  shop text := public.normalize_shop_host(p_shop);
  users text[];
  hosts text[];
  assignments text;
begin
  if shop is null then return 0; end if;

  select coalesce(array_agg(clerk_user_id), '{}'),
         array_remove(array_agg(distinct public.normalize_shop_host(shopify_custom_domain)), null) || shop
    into users, hosts
    from public.user_integrations
   where shop in (public.normalize_shop_host(shopify_store_url), public.normalize_shop_host(shop_domain));
  hosts := coalesce(hosts, array[shop]);

  -- A campaign belongs to this shop if its saved store says so. A linked user's
  -- campaign with no store recorded is treated as this shop's; one recorded
  -- against a different store is left alone.
  delete from public.campaigns c
   where public.normalize_shop_host(coalesce(c.brief_data #>> '{storeInsights,store,myshopify_domain}', c.brief_data #>> '{storeInsights,store,domain}')) = any(hosts)
      or (c.clerk_user_id = any(users)
          and public.normalize_shop_host(coalesce(c.brief_data #>> '{storeInsights,store,myshopify_domain}', c.brief_data #>> '{storeInsights,store,domain}')) is null);

  delete from public.brief_generation_receipts where clerk_user_id = any(users);
  delete from public.capi_events where shop_domain = shop or clerk_user_id = any(users);
  delete from public.webhook_deliveries where shop_domain = shop;
  delete from public.shopify_refresh_locks where user_id = any(users);

  -- Free-text references can name the merchant; Shopify charge ids cannot.
  update public.payments
     set provider_reference = null
   where clerk_user_id = any(users) and provider = 'shopify'
     and provider_reference is not null and provider_reference not like 'gid://%';

  if cardinality(users) > 0 then
    select string_agg(format('%I = null', column_name), ', ') into assignments
      from information_schema.columns
     where table_schema = 'public' and table_name = 'user_integrations'
       and column_name = any(array['shopify_access_token', 'access_token', 'shopify_refresh_token',
         'refresh_token', 'shopify_token_expires_at', 'token_expires_at', 'shopify_webhook_id',
         'shopify_scopes', 'store_snapshot', 'store_snapshot_at', 'shop_domain',
         'shopify_store_url', 'shopify_custom_domain']);
    execute format('update public.user_integrations set %s where clerk_user_id = any($1)', assignments)
      using users;
  end if;

  return cardinality(users);
end;
$$;

-- Removes exactly one account. Other members of a shared shop are untouched.
create or replace function public.delete_user_data(p_user_id text)
returns void language plpgsql set search_path = public as $$
declare
  anonymous_id text := 'deleted:' || gen_random_uuid();
begin
  delete from public.campaigns where clerk_user_id = p_user_id;
  delete from public.campaign_brief_versions where clerk_user_id = p_user_id;
  delete from public.brief_generation_receipts where clerk_user_id = p_user_id;
  delete from public.capi_events where clerk_user_id = p_user_id;
  delete from public.credit_usage where clerk_user_id = p_user_id;
  delete from public.email_log where user_id = p_user_id;
  delete from public.shopify_refresh_locks where user_id = p_user_id;
  delete from public.rate_limits where key like '%:' || p_user_id;
  update public.api_usage_log set user_id = null where user_id = p_user_id;
  update public.payments
     set clerk_user_id = anonymous_id,
         provider_reference = case when provider_reference like 'gid://%' then provider_reference end
   where clerk_user_id = p_user_id;
  delete from public.user_integrations where clerk_user_id = p_user_id;
end;
$$;

revoke all on function public.normalize_shop_host(text) from public, anon, authenticated;
revoke all on function public.disconnect_shop_installation(text) from public, anon, authenticated;
revoke all on function public.redact_shop_data(text) from public, anon, authenticated;
revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.normalize_shop_host(text) to service_role;
grant execute on function public.disconnect_shop_installation(text) to service_role;
grant execute on function public.redact_shop_data(text) to service_role;
grant execute on function public.delete_user_data(text) to service_role;
