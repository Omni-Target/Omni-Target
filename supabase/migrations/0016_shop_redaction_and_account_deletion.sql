-- SEC-09 (Phase S1): complete shop redaction, uninstall revocation and account
-- deletion. Each function is one transaction, so a failure leaves nothing
-- half-removed. Credit balances, payment records and generated ad copy are
-- deliberately kept by shop redaction; shop_domain is kept so a reinstall
-- reconnects to the same credits.

create or replace function public.redact_shop_data(p_shop text, p_tokens_only boolean default false)
returns integer language plpgsql set search_path = public as $$
declare
  shop text := regexp_replace(regexp_replace(lower(trim(p_shop)), '^https?://', ''), '/$', '');
  users text[];
  assignments text;
  token_columns text[] := array[
    'shopify_access_token', 'access_token', 'shopify_refresh_token', 'refresh_token',
    'shopify_token_expires_at', 'token_expires_at', 'shopify_webhook_id'
  ];
  connection_columns text[] := array[
    'shopify_scopes', 'store_snapshot', 'store_snapshot_at',
    'meta_access_token', 'meta_page_access_token', 'meta_ad_account_id', 'meta_pixel_id',
    'meta_business_id', 'meta_connected_at', 'meta_page_id', 'meta_page_name',
    'meta_ad_accounts', 'meta_selected_account_id', 'meta_pages'
  ];
begin
  if shop = '' then return 0; end if;

  select coalesce(array_agg(clerk_user_id), '{}') into users
    from public.user_integrations
   where shop in (
     regexp_replace(regexp_replace(lower(coalesce(shopify_store_url, '')), '^https?://', ''), '/$', ''),
     regexp_replace(regexp_replace(lower(coalesce(shop_domain, '')), '^https?://', ''), '/$', '')
   );
  if cardinality(users) = 0 then return 0; end if;

  -- Only columns that exist: deployed schemas have drifted from the repository.
  select string_agg(format('%I = null', column_name), ', ') into assignments
    from information_schema.columns
   where table_schema = 'public' and table_name = 'user_integrations'
     and column_name = any(
       case when p_tokens_only then token_columns else token_columns || connection_columns end
     );
  execute format('update public.user_integrations set %s where clerk_user_id = any($1)', assignments)
    using users;

  if not p_tokens_only then
    update public.campaigns
       set brief_data = brief_data - 'storeInsights', store_insights = null
     where clerk_user_id = any(users);
    update public.campaign_brief_versions
       set brief_data = brief_data - 'storeInsights'
     where clerk_user_id = any(users);
    delete from public.brief_generation_receipts where clerk_user_id = any(users);
    delete from public.capi_events where clerk_user_id = any(users);
  end if;

  return cardinality(users);
end;
$$;

-- Removes one account everywhere. Payment rows are anonymized rather than
-- deleted because they are accounting records.
create or replace function public.delete_user_data(p_user_id text)
returns void language plpgsql set search_path = public as $$
begin
  delete from public.campaign_brief_versions where clerk_user_id = p_user_id;
  delete from public.campaigns where clerk_user_id = p_user_id;
  delete from public.brief_generation_receipts where clerk_user_id = p_user_id;
  delete from public.capi_events where clerk_user_id = p_user_id;
  delete from public.credit_usage where clerk_user_id = p_user_id;
  delete from public.email_log where user_id = p_user_id;
  delete from public.shopify_refresh_locks where user_id = p_user_id;
  delete from public.rate_limits where key like '%:' || p_user_id;
  update public.api_usage_log set user_id = null where user_id = p_user_id;
  update public.payments set clerk_user_id = 'deleted:' || md5(p_user_id) where clerk_user_id = p_user_id;
  delete from public.user_integrations where clerk_user_id = p_user_id;
end;
$$;

revoke all on function public.redact_shop_data(text, boolean) from public, anon, authenticated;
revoke all on function public.delete_user_data(text) from public, anon, authenticated;
grant execute on function public.redact_shop_data(text, boolean) to service_role;
grant execute on function public.delete_user_data(text) to service_role;
