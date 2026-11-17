-- Reverses 0025: restores 0024's helpers, then drops the sync, inbox and
-- metric tables. Their rows are operational and are rebuilt by the next import.
create or replace function public.delete_shop_synced_data(p_domain text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_shop uuid;
begin
  select id into v_shop from public.shops where myshopify_domain = public.normalize_shop_host(p_domain);
  if v_shop is null then return; end if;
  delete from public.return_line_items where shop_id = v_shop;
  delete from public.returns where shop_id = v_shop;
  delete from public.refunds where shop_id = v_shop;
  delete from public.order_line_items where shop_id = v_shop;
  delete from public.orders where shop_id = v_shop;
  delete from public.customers where shop_id = v_shop;
  delete from public.inventory_levels where shop_id = v_shop;
  delete from public.inventory_locations where shop_id = v_shop;
  delete from public.product_variants where shop_id = v_shop;
  delete from public.products where shop_id = v_shop;
  delete from public.metafields where shop_id = v_shop;
  delete from public.metaobjects where shop_id = v_shop;
  delete from public.metaobject_definitions where shop_id = v_shop;
  delete from public.shop_settings where shop_id = v_shop;
  delete from public.shop_access where shop_id = v_shop;
end;
$$;

create or replace function public.shop_synced_row_count(p_domain text)
returns bigint language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_shop uuid;
begin
  select id into v_shop from public.shops where myshopify_domain = public.normalize_shop_host(p_domain);
  if v_shop is null then return 0; end if;
  return (select count(*) from public.products where shop_id = v_shop)
       + (select count(*) from public.product_variants where shop_id = v_shop)
       + (select count(*) from public.inventory_locations where shop_id = v_shop)
       + (select count(*) from public.inventory_levels where shop_id = v_shop)
       + (select count(*) from public.customers where shop_id = v_shop)
       + (select count(*) from public.orders where shop_id = v_shop)
       + (select count(*) from public.order_line_items where shop_id = v_shop)
       + (select count(*) from public.refunds where shop_id = v_shop)
       + (select count(*) from public.returns where shop_id = v_shop)
       + (select count(*) from public.return_line_items where shop_id = v_shop)
       + (select count(*) from public.metafields where shop_id = v_shop)
       + (select count(*) from public.metaobject_definitions where shop_id = v_shop)
       + (select count(*) from public.metaobjects where shop_id = v_shop)
       + (select count(*) from public.shop_settings where shop_id = v_shop)
       + (select count(*) from public.shop_access where shop_id = v_shop);
end;
$$;

drop table if exists public.store_metrics;
drop table if exists public.product_metrics;
drop table if exists public.webhook_events;
drop table if exists public.sync_checkpoints;
drop table if exists public.sync_runs;
