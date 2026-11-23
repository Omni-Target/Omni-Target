-- Phase 3, task 3: inventory and fulfilment.
--
--  - inventory_levels: every quantity state Shopify reports (available, committed, incoming, on hand,
--    reserved, damaged, safety stock, quality control) and whether the level is active. Null: not read
--    (rows written before this migration hold available and on hand only).
--  - inventory_locations: fulfilment-service details (handle, name, type: manual, third party or gift
--    card; whether the service manages inventory), whether the location ships inventory or has active
--    inventory, when it was deactivated, and the field set it was read with.
--  - ingest_inventory gains p_complete_items: items whose full, current list of levels the batch holds
--    (a by-ID read), so a level at a location the item no longer stocks is removed. A bulk export is not
--    passed as complete: it may be older than a level a webhook wrote meanwhile.
--  - inventory_availability: per variant, by location and in total, over the locations that are active
--    and fulfil online orders, never one location taken for the shop; a state (untracked, in stock,
--    oversell allowed, out of stock, unknown) and what it rests on; who fulfils it (merchant, third-party
--    or other fulfilment service) and whether it is a Shopify Collective product (Shopify's tag).
--  - insight_products gives each variant's tracking, policy and online availability to the read path.
-- Existing rows are unchanged.

alter table public.inventory_levels
  add column committed        integer,
  add column incoming         integer,
  add column reserved         integer,
  add column damaged          integer,
  add column safety_stock     integer,
  add column quality_control  integer,
  add column is_active        boolean;

alter table public.inventory_locations
  add column fields_version                 smallint check (fields_version > 0),
  add column ships_inventory                boolean,
  add column has_active_inventory           boolean,
  add column deactivated_at                 timestamptz,
  add column fulfillment_service_handle     text check (char_length(fulfillment_service_handle) <= 255),
  add column fulfillment_service_name       text check (char_length(fulfillment_service_name) <= 255),
  add column fulfillment_service_type       text check (fulfillment_service_type in ('manual', 'third_party', 'gift_card')),
  add column fulfillment_service_inventory  boolean;

drop function public.ingest_inventory(integer, jsonb, jsonb);
create or replace function public.ingest_inventory(p_shop_key integer, p_locations jsonb, p_levels jsonb, p_complete_items bigint[] default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_locations integer := 0;
  v_levels integer := 0;
  v_removed integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if public.ingest_batch_size(p_locations, p_levels) + coalesce(cardinality(p_complete_items), 0) > 2000 then raise exception 'ingest_batch_too_large'; end if;

  insert into public.inventory_locations as l (shop_key, shopify_id, name, country_code, province_code, is_active, fulfills_online_orders,
    is_fulfillment_service, synced_at, fields_version, ships_inventory, has_active_inventory, deactivated_at, fulfillment_service_handle,
    fulfillment_service_name, fulfillment_service_type, fulfillment_service_inventory)
  select p_shop_key, x.shopify_id, x.name, x.country_code, x.province_code, coalesce(x.is_active, true), x.fulfills_online_orders,
         coalesce(x.is_fulfillment_service, false), now(), x.fields_version, x.ships_inventory, x.has_active_inventory, x.deactivated_at,
         x.fulfillment_service_handle, x.fulfillment_service_name, x.fulfillment_service_type, x.fulfillment_service_inventory
    from jsonb_to_recordset(coalesce(p_locations, '[]')) as x(shopify_id bigint, name text, country_code text, province_code text,
         is_active boolean, fulfills_online_orders boolean, is_fulfillment_service boolean, fields_version smallint, ships_inventory boolean,
         has_active_inventory boolean, deactivated_at timestamptz, fulfillment_service_handle text, fulfillment_service_name text,
         fulfillment_service_type text, fulfillment_service_inventory boolean)
  on conflict (shop_key, shopify_id) do update set
    name = excluded.name, country_code = excluded.country_code, province_code = excluded.province_code, is_active = excluded.is_active,
    fulfills_online_orders = excluded.fulfills_online_orders, is_fulfillment_service = excluded.is_fulfillment_service, synced_at = now(),
    fields_version = excluded.fields_version, ships_inventory = excluded.ships_inventory, has_active_inventory = excluded.has_active_inventory,
    deactivated_at = excluded.deactivated_at, fulfillment_service_handle = excluded.fulfillment_service_handle,
    fulfillment_service_name = excluded.fulfillment_service_name, fulfillment_service_type = excluded.fulfillment_service_type,
    fulfillment_service_inventory = excluded.fulfillment_service_inventory;
  get diagnostics v_locations = row_count;

  insert into public.inventory_levels as l (shop_key, inventory_item_id, location_shopify_id, available, on_hand, shopify_updated_at, synced_at,
    committed, incoming, reserved, damaged, safety_stock, quality_control, is_active)
  select p_shop_key, x.inventory_item_id, x.location_shopify_id, x.available, x.on_hand, x.shopify_updated_at, now(),
         x.committed, x.incoming, x.reserved, x.damaged, x.safety_stock, x.quality_control, x.is_active
    from jsonb_to_recordset(coalesce(p_levels, '[]')) as x(inventory_item_id bigint, location_shopify_id bigint, available integer,
         on_hand integer, shopify_updated_at timestamptz, committed integer, incoming integer, reserved integer, damaged integer,
         safety_stock integer, quality_control integer, is_active boolean)
  on conflict (shop_key, inventory_item_id, location_shopify_id) do update set
    available = excluded.available, on_hand = excluded.on_hand, shopify_updated_at = excluded.shopify_updated_at, synced_at = now(),
    committed = excluded.committed, incoming = excluded.incoming, reserved = excluded.reserved, damaged = excluded.damaged,
    safety_stock = excluded.safety_stock, quality_control = excluded.quality_control, is_active = excluded.is_active
   where l.shopify_updated_at is null or excluded.shopify_updated_at is null or excluded.shopify_updated_at >= l.shopify_updated_at;
  get diagnostics v_levels = row_count;

  -- A complete item's levels are exactly those in the batch.
  delete from public.inventory_levels l
   where l.shop_key = p_shop_key and l.inventory_item_id = any (coalesce(p_complete_items, '{}'))
     and not exists (select 1 from jsonb_to_recordset(coalesce(p_levels, '[]')) as x(inventory_item_id bigint, location_shopify_id bigint)
                      where x.inventory_item_id = l.inventory_item_id and x.location_shopify_id = l.location_shopify_id);
  get diagnostics v_removed = row_count;

  return jsonb_build_object('locations', v_locations, 'levels', v_levels, 'levels_removed', v_removed);
end;
$$;

-- Availability per variant (at most 500): by location, and in total over the locations that are active and
-- fulfil online orders (the shop's sellable stock), and over all active locations. Levels at a location the
-- mirror does not know are counted apart, never in a total. "Unavailable" is Shopify's: damaged, quality
-- control, reserved and safety stock. The state says what the totals rest on:
--   untracked         Shopify does not track the variant's inventory: it sells without stock;
--   unknown           tracked, but no inventory level is stored for it;
--   in_stock          available at an online location;
--   oversell_allowed  none available, but its policy is to keep selling;
--   out_of_stock      none available at an online location, and it stops selling.
create or replace function public.inventory_availability(p_shop_key integer, p_variant_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'variant_id', v.shopify_id, 'product_id', v.product_shopify_id, 'tracked', v.tracked, 'inventory_policy', v.inventory_policy,
           'requires_shipping', v.requires_shipping, 'variant_quantity', v.inventory_quantity,
           -- Shopify tags the products a retailer sells through Shopify Collective (fulfilled by the supplier).
           'collective', coalesce('Shopify Collective' = any (p.tags), false),
           'state', case when v.tracked is false then 'untracked'
                         when v.inventory_item_id is null or coalesce(a.levels, 0) = 0 then 'unknown'
                         when coalesce(a.online_available, 0) > 0 then 'in_stock'
                         when v.inventory_policy = 'continue' then 'oversell_allowed'
                         else 'out_of_stock' end,
           'quantities_read', coalesce(a.quantities_read, false),
           'online', jsonb_build_object('locations', coalesce(a.online_locations, 0), 'available', a.online_available, 'committed', a.online_committed,
                                        'incoming', a.online_incoming, 'unavailable', a.online_unavailable, 'on_hand', a.online_on_hand),
           'active', jsonb_build_object('locations', coalesce(a.active_locations, 0), 'available', a.active_available, 'on_hand', a.active_on_hand),
           'unknown_locations', coalesce(a.unknown_locations, 0),
           'fulfilment', coalesce(a.fulfilment, '[]'::jsonb),
           'locations', coalesce(a.locations, '[]'::jsonb)
         ) order by v.shopify_id), '[]'::jsonb)
    from public.product_variants v
    left join public.products p on p.shop_key = v.shop_key and p.shopify_id = v.product_shopify_id
    left join lateral (
      select count(*) as levels,
             bool_and(l.committed is not null) as quantities_read,
             count(*) filter (where o.online) as online_locations,
             sum(l.available) filter (where o.online) as online_available,
             sum(l.committed) filter (where o.online) as online_committed,
             sum(l.incoming) filter (where o.online) as online_incoming,
             sum(l.damaged + l.quality_control + l.reserved + l.safety_stock) filter (where o.online) as online_unavailable,
             sum(l.on_hand) filter (where o.online) as online_on_hand,
             count(*) filter (where o.active) as active_locations,
             sum(l.available) filter (where o.active) as active_available,
             sum(l.on_hand) filter (where o.active) as active_on_hand,
             count(*) filter (where loc.shopify_id is null) as unknown_locations,
             coalesce(jsonb_agg(distinct coalesce(loc.fulfillment_service_type, case when loc.is_fulfillment_service then 'fulfillment_service' else 'merchant' end))
                        filter (where o.active), '[]'::jsonb) as fulfilment,
             jsonb_agg(jsonb_build_object('location_id', l.location_shopify_id, 'name', loc.name, 'known', loc.shopify_id is not null,
                         'active', o.active, 'online', o.online, 'fulfillment_service_type', loc.fulfillment_service_type,
                         'available', l.available, 'committed', l.committed, 'incoming', l.incoming, 'on_hand', l.on_hand,
                         'unavailable', l.damaged + l.quality_control + l.reserved + l.safety_stock)
                       order by l.location_shopify_id) as locations
        from public.inventory_levels l
        left join public.inventory_locations loc on loc.shop_key = l.shop_key and loc.shopify_id = l.location_shopify_id
        cross join lateral (select coalesce(loc.is_active, false) and l.is_active is not false as active,
                                   coalesce(loc.is_active, false) and l.is_active is not false and loc.fulfills_online_orders is true as online) o
       where l.shop_key = p_shop_key and l.inventory_item_id = v.inventory_item_id
    ) a on true
   where v.shop_key = p_shop_key and v.shopify_id = any ((coalesce(p_variant_ids, '{}'))[1:500]);
$$;

-- The read path's products (0044), with each variant's tracking, policy and online availability.
create or replace function public.insight_products(p_shop_key integer, p_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.shopify_id, 'title', p.title, 'handle', p.handle, 'description', p.description_excerpt, 'tags', p.tags,
           'product_type', p.product_type, 'vendor', p.vendor, 'status', p.status, 'created_at', p.shopify_created_at,
           'category', p.category, 'image_url', p.featured_image_url, 'fields_version', p.fields_version,
           'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.shopify_id, 'title', v.title, 'price', v.price,
                                   'inventory_quantity', v.inventory_quantity, 'unit_cost', v.unit_cost, 'unit_cost_currency', v.unit_cost_currency,
                                   'tracked', v.tracked, 'inventory_policy', v.inventory_policy,
                                   'available_online', (select sum(l.available) from public.inventory_levels l
                                                          join public.inventory_locations loc on loc.shop_key = l.shop_key and loc.shopify_id = l.location_shopify_id
                                                         where l.shop_key = p_shop_key and l.inventory_item_id = v.inventory_item_id
                                                           and loc.is_active and loc.fulfills_online_orders is true and l.is_active is not false))
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

revoke all on function public.ingest_inventory(integer, jsonb, jsonb, bigint[]), public.inventory_availability(integer, bigint[])
  from public, anon, authenticated;
grant execute on function public.ingest_inventory(integer, jsonb, jsonb, bigint[]), public.inventory_availability(integer, bigint[]) to service_role;
