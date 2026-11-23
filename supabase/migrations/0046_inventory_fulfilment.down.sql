-- Reverts 0046: 0032's inventory write and 0044's read-path products, then the new function and columns.
drop function public.inventory_availability(integer, bigint[]);
drop function public.ingest_inventory(integer, jsonb, jsonb, bigint[]);
create or replace function public.ingest_inventory(p_shop_key integer, p_locations jsonb, p_levels jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_locations integer := 0;
  v_levels integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_locations, p_levels) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  insert into public.inventory_locations as l (shop_key, shopify_id, name, country_code, province_code, is_active, fulfills_online_orders, is_fulfillment_service, synced_at)
  select p_shop_key, x.shopify_id, x.name, x.country_code, x.province_code, coalesce(x.is_active, true), x.fulfills_online_orders,
         coalesce(x.is_fulfillment_service, false), now()
    from jsonb_to_recordset(coalesce(p_locations, '[]')) as x(shopify_id bigint, name text, country_code text, province_code text,
         is_active boolean, fulfills_online_orders boolean, is_fulfillment_service boolean)
  on conflict (shop_key, shopify_id) do update set
    name = excluded.name, country_code = excluded.country_code, province_code = excluded.province_code, is_active = excluded.is_active,
    fulfills_online_orders = excluded.fulfills_online_orders, is_fulfillment_service = excluded.is_fulfillment_service, synced_at = now();
  get diagnostics v_locations = row_count;

  insert into public.inventory_levels as l (shop_key, inventory_item_id, location_shopify_id, available, on_hand, shopify_updated_at, synced_at)
  select p_shop_key, x.inventory_item_id, x.location_shopify_id, x.available, x.on_hand, x.shopify_updated_at, now()
    from jsonb_to_recordset(coalesce(p_levels, '[]')) as x(inventory_item_id bigint, location_shopify_id bigint, available integer,
         on_hand integer, shopify_updated_at timestamptz)
  on conflict (shop_key, inventory_item_id, location_shopify_id) do update set
    available = excluded.available, on_hand = excluded.on_hand, shopify_updated_at = excluded.shopify_updated_at, synced_at = now()
   where l.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= l.shopify_updated_at;
  get diagnostics v_levels = row_count;

  return jsonb_build_object('locations', v_locations, 'levels', v_levels);
end;
$$;
revoke all on function public.ingest_inventory(integer, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_inventory(integer, jsonb, jsonb) to service_role;

create or replace function public.insight_products(p_shop_key integer, p_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.shopify_id, 'title', p.title, 'handle', p.handle, 'description', p.description_excerpt, 'tags', p.tags,
           'product_type', p.product_type, 'vendor', p.vendor, 'status', p.status, 'created_at', p.shopify_created_at,
           'category', p.category, 'image_url', p.featured_image_url, 'fields_version', p.fields_version,
           'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.shopify_id, 'title', v.title, 'price', v.price,
                                   'inventory_quantity', v.inventory_quantity, 'unit_cost', v.unit_cost, 'unit_cost_currency', v.unit_cost_currency)
                                   order by v.position nulls last, v.shopify_id)
                                   from public.product_variants v where v.shop_key = p_shop_key and v.product_shopify_id = p.shopify_id), '[]'::jsonb),
           'metafields', coalesce((select jsonb_agg(jsonb_build_object('owner', m.owner_type, 'namespace', m.namespace, 'key', m.key,
                                     'type', m.type, 'value', m.value_excerpt, 'name', d.name)
                                     order by m.owner_type, m.namespace, m.key, m.owner_shopify_id)
                                     from public.metafields m
                                     left join public.metafield_definitions d on d.shop_key = m.shop_key and d.owner_type = m.owner_type
                                          and d.namespace = m.namespace and d.key = m.key
                                    where m.shop_key = p_shop_key and not m.value_truncated
                                      and ((m.owner_type = 'product' and m.owner_shopify_id = p.shopify_id)
                                           or (m.owner_type = 'variant' and m.owner_shopify_id in (
                                                 select v.shopify_id from public.product_variants v
                                                  where v.shop_key = p_shop_key and v.product_shopify_id = p.shopify_id)))), '[]'::jsonb)
         ) order by p.shopify_id), '[]'::jsonb)
    from public.products p
   where p.shop_key = p_shop_key and p.shopify_id = any ((coalesce(p_ids, '{}'))[1:500]);
$$;

alter table public.inventory_locations
  drop column fields_version, drop column ships_inventory, drop column has_active_inventory, drop column deactivated_at,
  drop column fulfillment_service_handle, drop column fulfillment_service_name, drop column fulfillment_service_type,
  drop column fulfillment_service_inventory;
alter table public.inventory_levels
  drop column committed, drop column incoming, drop column reserved, drop column damaged, drop column safety_stock,
  drop column quality_control, drop column is_active;
