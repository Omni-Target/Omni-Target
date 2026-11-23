-- Phase 3, task 6: product data-quality facts.
--
-- product_quality_facts gathers, for at most 500 products, the facts the data-quality rules
-- (src/modules/quality/rules.ts) judge each field by: which field set a product was read with, what its
-- variants hold (costs and their currency, weights for shipped variants, barcodes, compare-at prices,
-- customs codes, tracking and policy), its inventory levels (and whether they are at known locations and
-- hold every quantity), and its specifications (metafields, their definitions, truncation and unresolved
-- metaobject references). Rules live in code, versioned (calc_version), so states and reasons can change
-- without a migration; flags are computed when read, never stored, and so are never stale.
create or replace function public.product_quality_facts(p_shop_key integer, p_product_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with wanted as (select unnest((coalesce(p_product_ids, '{}'))[1:500]) as id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', p.shopify_id,
           'status', p.status,
           'fields_version', p.fields_version,
           'is_gift_card', p.is_gift_card,
           'collective', coalesce('Shopify Collective' = any (p.tags), false),
           'has_description', p.description_excerpt is not null,
           'description_truncated', p.description_truncated,
           'has_category', p.category is not null,
           'has_image', p.featured_image_url is not null,
           'media_count', p.media_count,
           'synced_at', p.synced_at,
           'variants', v.variants,
           'zero_price', v.zero_price,
           'with_cost', v.with_cost,
           'cost_currencies', v.cost_currencies,
           'shipped', v.shipped,
           'shipped_without_weight', v.shipped_without_weight,
           'shipping_unknown', v.shipping_unknown,
           'with_barcode', v.with_barcode,
           'with_compare_at', v.with_compare_at,
           'compare_at_not_above', v.compare_at_not_above,
           'with_hs_code', v.with_hs_code,
           'with_origin', v.with_origin,
           'tracked', v.tracked,
           'untracked', v.untracked,
           'keep_selling', v.keep_selling,
           'tracked_with_levels', i.tracked_with_levels,
           'levels', i.levels,
           'levels_unknown_location', i.levels_unknown_location,
           'levels_partial_quantities', i.levels_partial_quantities,
           'levels_third_party', i.levels_third_party,
           'metafields', m.metafields,
           'metafields_defined', m.defined,
           'metafields_truncated', m.truncated,
           'references', m.references,
           'references_unresolved', m.unresolved
         ) order by p.shopify_id), '[]'::jsonb)
    from wanted w
    join public.products p on p.shop_key = p_shop_key and p.shopify_id = w.id
    left join lateral (
      select count(*) as variants,
             count(*) filter (where x.price = 0) as zero_price,
             count(*) filter (where x.unit_cost is not null) as with_cost,
             coalesce(jsonb_agg(distinct x.unit_cost_currency) filter (where x.unit_cost_currency is not null), '[]'::jsonb) as cost_currencies,
             count(*) filter (where x.requires_shipping) as shipped,
             count(*) filter (where x.requires_shipping and coalesce(x.weight, 0) = 0) as shipped_without_weight,
             count(*) filter (where x.requires_shipping is null) as shipping_unknown,
             count(*) filter (where x.barcode is not null) as with_barcode,
             count(*) filter (where x.compare_at_price is not null) as with_compare_at,
             count(*) filter (where x.compare_at_price is not null and x.compare_at_price <= x.price) as compare_at_not_above,
             count(*) filter (where x.harmonized_system_code is not null) as with_hs_code,
             count(*) filter (where x.country_of_origin is not null) as with_origin,
             count(*) filter (where x.tracked) as tracked,
             count(*) filter (where x.tracked is false) as untracked,
             count(*) filter (where x.inventory_policy = 'continue') as keep_selling
        from public.product_variants x where x.shop_key = p_shop_key and x.product_shopify_id = p.shopify_id
    ) v on true
    left join lateral (
      select count(distinct x.shopify_id) filter (where x.tracked and l.inventory_item_id is not null) as tracked_with_levels,
             count(l.*) as levels,
             count(l.*) filter (where l.inventory_item_id is not null and loc.shopify_id is null) as levels_unknown_location,
             count(l.*) filter (where l.inventory_item_id is not null and l.committed is null) as levels_partial_quantities,
             count(l.*) filter (where loc.fulfillment_service_type = 'third_party') as levels_third_party
        from public.product_variants x
        left join public.inventory_levels l on l.shop_key = x.shop_key and l.inventory_item_id = x.inventory_item_id
        left join public.inventory_locations loc on loc.shop_key = l.shop_key and loc.shopify_id = l.location_shopify_id
       where x.shop_key = p_shop_key and x.product_shopify_id = p.shopify_id
    ) i on true
    left join lateral (
      select count(*) as metafields,
             count(*) filter (where d.key is not null) as defined,
             count(*) filter (where mf.value_truncated) as truncated,
             coalesce(sum(r.refs), 0) as references,
             coalesce(sum(r.unresolved), 0) as unresolved
        from public.metafields mf
        left join public.metafield_definitions d on d.shop_key = mf.shop_key and d.owner_type = mf.owner_type and d.namespace = mf.namespace and d.key = mf.key
        left join lateral (
          select count(*) as refs, count(*) filter (where o.shopify_id is null) as unresolved
            from regexp_matches(coalesce(mf.value_excerpt, ''), 'gid://shopify/Metaobject/([0-9]{1,18})', 'g') as g(m)
            left join public.metaobjects o on o.shop_key = mf.shop_key and o.shopify_id = g.m[1]::bigint
           where mf.type ~ 'metaobject_reference|mixed_reference'
        ) r on true
       where mf.shop_key = p_shop_key
         and ((mf.owner_type = 'product' and mf.owner_shopify_id = p.shopify_id)
              or (mf.owner_type = 'variant' and mf.owner_shopify_id in (select y.shopify_id from public.product_variants y
                                                                          where y.shop_key = p_shop_key and y.product_shopify_id = p.shopify_id)))
    ) m on true;
$$;

revoke all on function public.product_quality_facts(integer, bigint[]) from public, anon, authenticated;
grant execute on function public.product_quality_facts(integer, bigint[]) to service_role;
