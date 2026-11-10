-- Reverses 0020. Encrypted credentials are discarded: every shop and Meta
-- connection must be re-established afterwards. Take a backup first on any
-- database that holds real connections.

drop trigger if exists workspaces_clear_credentials on public.workspaces;

drop function if exists public.shop_owner(text);
drop function if exists public.current_workspace_for_actor(text, uuid);
drop function if exists public.meta_user_credentials_for_owner(text);
drop function if exists public.clear_meta_connection(uuid, text);
drop function if exists public.meta_access_for_shop(text);
drop function if exists public.meta_access_for_workspace(uuid, text);
drop function if exists public.select_meta_page(uuid, text, text, jsonb);
drop function if exists public.select_meta_ad_account(uuid, text, text);
drop function if exists public.store_meta_connection(uuid, text, jsonb, jsonb, jsonb);
drop function if exists public.meta_workspace_writable(uuid, text);
drop function if exists public.reseal_meta_credential(uuid, text, bigint, jsonb);
drop function if exists public.credentials_below_key_version(integer, integer);
drop function if exists public.reseal_shop_credential(uuid, bigint, jsonb);
drop function if exists public.record_shop_refresh_failure(uuid, bigint, boolean, text);
drop function if exists public.store_refreshed_shop_credential(uuid, uuid, bigint, jsonb);
drop function if exists public.shop_credential_for_shop(text);
drop function if exists public.shop_credential_for_workspace(uuid, text);
drop function if exists public.commit_shop_install_under_lease(text, uuid, bigint, text, text, uuid, text, uuid, jsonb);
drop function if exists public.clear_workspace_credentials();
drop function if exists public.store_meta_credential(uuid, text, jsonb);
drop function if exists public.meta_sealed(public.workspace_meta_credentials);
drop function if exists public.shop_credential_payload(public.shop_credentials, public.shops);
drop function if exists public.store_shop_credential(uuid, uuid, jsonb);
drop function if exists public.sealed_part(jsonb, text);

drop table if exists public.workspace_meta_connections;
drop table if exists public.workspace_meta_credentials;
drop table if exists public.shop_credentials;

-- connect_check_under_lease as 0019 defined it.
create or replace function public.connect_check_under_lease(p_lease_domain text, p_holder uuid, p_actor text, p_transfer uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domain text := public.myshopify_domain_or_null(p_lease_domain);
begin
  if v_domain is null or not public.hold_shop_lease(public.install_lease_key(v_domain), p_holder) then
    return jsonb_build_object('outcome', 'rejected_lease_lost');
  end if;
  if p_transfer is null then
    return public.shop_connection_preflight(v_domain, p_actor);
  end if;
  if exists (
    select 1 from public.ownership_transfers t join public.shops s on s.id = t.shop_id
     where t.id = p_transfer and t.requested_by_clerk_user_id = p_actor and t.status = 'approved'
       and t.expires_at > now() and s.myshopify_domain = v_domain
  ) then
    return jsonb_build_object('outcome', 'allowed');
  end if;
  return jsonb_build_object('outcome', 'rejected_transfer_not_ready');
end;
$$;

grant execute on function
  public.bind_shop_under_lease(text, uuid, bigint, text, text, uuid, text),
  public.complete_transfer_under_lease(text, uuid, uuid, text, bigint)
to service_role;
