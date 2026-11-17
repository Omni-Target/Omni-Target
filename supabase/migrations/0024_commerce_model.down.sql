-- Reverses 0024: restores 0018's deletion functions, then drops the commerce
-- mirror. Any mirrored rows are discarded; they are re-imported from Shopify.
create or replace function public.process_workspace_deletion(p_deletion uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_deletion public.workspace_deletions%rowtype;
  v_ws public.workspaces%rowtype;
  v_shop uuid;
  v_domain text;
  v_remaining jsonb;
begin
  select * into v_deletion from public.workspace_deletions where id = p_deletion for update;
  if not found then raise exception 'deletion_not_found'; end if;
  if v_deletion.status = 'completed' then return jsonb_build_object('outcome', 'completed', 'workspace_id', v_deletion.workspace_id); end if;
  update public.workspace_deletions set attempts = attempts + 1, started_at = coalesce(started_at, now()) where id = p_deletion;

  select * into v_ws from public.workspaces where id = v_deletion.workspace_id for update;
  select s.id, s.myshopify_domain into v_shop, v_domain from public.shop_bindings b join public.shops s on s.id = b.shop_id
   where b.workspace_id = v_ws.id and b.released_at is null;

  begin
    if v_domain is not null then
      perform public.redact_shop_data(v_domain);
    end if;
    delete from public.campaign_brief_versions where campaign_id in (select id from public.campaigns where workspace_id = v_ws.id);
    delete from public.campaigns where workspace_id = v_ws.id;

    v_remaining := jsonb_build_object(
      'integration_rows_naming_shop', (select count(*) from public.user_integrations
         where v_domain is not null and v_domain in (public.normalize_shop_host(shop_domain), public.normalize_shop_host(shopify_store_url))),
      'workspace_campaigns', (select count(*) from public.campaigns where workspace_id = v_ws.id),
      'capi_events', (select count(*) from public.capi_events where v_domain is not null and shop_domain = v_domain),
      'webhook_deliveries', (select count(*) from public.webhook_deliveries where v_domain is not null and shop_domain = v_domain));
    if exists (select 1 from jsonb_each_text(v_remaining) where value::int > 0) then
      raise exception 'deletion_verification_failed';
    end if;
  exception when others then
    update public.workspace_deletions set status = 'failed', last_error = sqlerrm, verification = v_remaining where id = p_deletion;
    return jsonb_build_object('outcome', 'failed', 'error', sqlerrm, 'workspace_id', v_ws.id);
  end;

  update public.shop_bindings set released_at = now(), release_reason = 'deletion_completed'
   where workspace_id = v_ws.id and released_at is null;
  update public.workspaces set status = 'deleted', status_changed_at = now(), deleted_at = now() where id = v_ws.id;
  update public.workspace_deletions set status = 'completed', completed_at = now(), verification = v_remaining, last_error = null where id = p_deletion;
  update public.compliance_requests set status = 'completed', completed_at = now(), resolution = 'shop_data_deleted'
   where workspace_id = v_ws.id and status <> 'completed';
  perform public.log_workspace_event(v_ws.id, v_shop, 'deletion_verified', null, 'system', null, v_remaining);
  perform public.log_workspace_event(v_ws.id, v_shop, 'deleted', null, 'system', null, '{}'::jsonb);
  return jsonb_build_object('outcome', 'completed', 'workspace_id', v_ws.id, 'verification', v_remaining);
end;
$$;

create or replace function public.process_unbound_shop_redact(p_request uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request public.compliance_requests%rowtype;
  v_remaining integer;
begin
  select * into v_request from public.compliance_requests where id = p_request and topic = 'shop/redact' for update;
  if not found then raise exception 'compliance_request_not_found'; end if;
  if v_request.status = 'completed' then return jsonb_build_object('outcome', 'completed'); end if;
  if v_request.workspace_id is not null then return jsonb_build_object('outcome', 'has_workspace'); end if;
  perform public.redact_shop_data(v_request.shop_domain);
  select count(*) into v_remaining from public.user_integrations
   where v_request.shop_domain in (public.normalize_shop_host(shop_domain), public.normalize_shop_host(shopify_store_url));
  if v_remaining > 0 then
    update public.compliance_requests set status = 'processing' where id = p_request;
    return jsonb_build_object('outcome', 'failed', 'remaining', v_remaining);
  end if;
  update public.compliance_requests set status = 'completed', completed_at = now(), resolution = 'legacy_shop_data_deleted' where id = p_request;
  return jsonb_build_object('outcome', 'completed');
end;
$$;

drop function if exists public.shop_synced_row_count(text);
drop function if exists public.delete_shop_synced_data(text);
drop table if exists public.shop_access;
drop table if exists public.shop_settings;
drop table if exists public.metaobjects;
drop table if exists public.metaobject_definitions;
drop table if exists public.metafields;
drop table if exists public.return_line_items;
drop table if exists public.returns;
drop table if exists public.refunds;
drop table if exists public.order_line_items;
drop table if exists public.orders;
drop table if exists public.customers;
drop table if exists public.inventory_levels;
drop table if exists public.inventory_locations;
drop table if exists public.product_variants;
drop table if exists public.products;
