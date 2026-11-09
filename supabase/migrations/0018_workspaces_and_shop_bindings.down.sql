-- Reverses 0018. Drops the workspace model and everything recorded in it
-- (bindings, lifecycle events, compliance requests, transfers, legacy claims).
-- Take a backup first on any database that holds real records.

drop function if exists public.shop_operations_allowed(text);
drop function if exists public.workspace_can_operate(uuid);
drop function if exists public.campaign_for_actor(uuid, uuid, text);
drop function if exists public.workspace_credit_balance(uuid, text);
drop function if exists public.list_workspaces(text);
drop function if exists public.workspace_for_actor(uuid, text);
drop function if exists public.review_legacy_claims(text, uuid, text, text);
drop function if exists public.register_legacy_account(uuid, text, text);
drop function if exists public.cancel_ownership_transfer(uuid, text);
drop function if exists public.complete_ownership_transfer(uuid, text, bigint);
drop function if exists public.approve_ownership_transfer(uuid, text);
drop function if exists public.verify_ownership_transfer(uuid, text, text);
drop function if exists public.request_ownership_transfer(text, text, uuid, text);
drop function if exists public.process_unbound_shop_redact(uuid);
drop function if exists public.process_workspace_deletion(uuid);
drop function if exists public.record_customer_compliance(text, bigint, text, text, timestamptz);
drop function if exists public.record_shop_redact(bigint, text, text, timestamptz);
drop function if exists public.begin_uninstall(bigint, text, text, timestamptz);
drop function if exists public.disconnect_workspace(uuid, text);
drop function if exists public.bind_shop_for_install(bigint, text, text, uuid, text);
drop function if exists public.shop_connection_preflight(text, text);
drop function if exists public.find_shop(bigint, text);
drop function if exists public.shop_has_open_redaction(bigint, text);
drop function if exists public.log_workspace_event(uuid, uuid, text, text, text, timestamptz, jsonb);

-- redact_shop_data as 0016 defined it.
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

drop index if exists public.campaigns_workspace_idx;
alter table public.campaigns drop column if exists workspace_id;

drop table if exists public.legacy_shop_claims;
drop table if exists public.ownership_transfers;
drop table if exists public.workspace_deletions;
drop table if exists public.compliance_requests;
drop table if exists public.shop_lifecycle_events;
drop table if exists public.workspace_events;
drop table if exists public.shop_bindings;
drop table if exists public.shops;
drop trigger if exists workspaces_credit_account on public.workspaces;
drop table if exists public.credit_accounts;
drop table if exists public.workspaces;

drop function if exists public.create_credit_account();
drop function if exists public.reject_row_mutation();
drop function if exists public.myshopify_domain_or_null(text);
