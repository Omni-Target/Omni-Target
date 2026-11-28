-- 0061_product_geography: where a product's buyers are, from its own paid orders (Phase 5, task 4;
-- architecture/phase-5-intelligence.md, "Product geography"). Counts only: no address line, postcode, name or
-- customer identifier is read. Three scopes, so the rules (src/modules/intelligence/geography.ts) can fall back
-- from the product to its category to the store, and label which they used:
--  - product: paid, non-test orders in the window containing the product;
--  - category: the same for every product sharing its Shopify category (else its product type);
--  - store: every paid, non-test order in the window.
-- Each scope gives its order count, how many carry a shipping country, and the top countries, regions (country and
-- province) and cities (country and the normalised city), at most 25 of each.

create or replace function public.product_geography_evidence(p_shop_key integer, p_product_ids bigint[], p_as_of timestamptz, p_window_days integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with wanted as (
    select p.shopify_id as id, coalesce(nullif(p.category, ''), nullif(p.product_type, '')) as category_key
      from unnest((coalesce(p_product_ids, '{}'))[1:200]) as x(id)
      join public.products p on p.shop_key = p_shop_key and p.shopify_id = x.id
  ),
  paid as (
    select o.shopify_id, o.ship_country_code as country, o.ship_province_code as province, o.ship_city as city
      from public.orders o
     where o.shop_key = p_shop_key and not o.is_test
       and o.financial_status in ('paid', 'partially_refunded', 'refunded')
       and o.processed_at > p_as_of - make_interval(days => p_window_days) and o.processed_at <= p_as_of
  ),
  lines as (
    select distinct li.product_shopify_id as product_id, li.order_shopify_id as order_id
      from public.order_line_items li
     where li.shop_key = p_shop_key and li.product_shopify_id is not null
       and li.order_shopify_id in (select shopify_id from paid)
  ),
  category_of as (
    select p.shopify_id as product_id, coalesce(nullif(p.category, ''), nullif(p.product_type, '')) as category_key
      from public.products p
     where p.shop_key = p_shop_key and coalesce(nullif(p.category, ''), nullif(p.product_type, '')) in (select category_key from wanted where category_key is not null)
  ),
  scoped as (
    select 'product:' || w.id::text as scope, o.* from wanted w join lines l on l.product_id = w.id join paid o on o.shopify_id = l.order_id
    union
    select 'category:' || c.category_key as scope, o.* from category_of c join lines l on l.product_id = c.product_id join paid o on o.shopify_id = l.order_id
    union all
    select 'store' as scope, o.* from paid o
  ),
  summary as (
    select scope, jsonb_build_object(
      'orders', count(*),
      'with_country', count(*) filter (where country is not null),
      'countries', coalesce((select jsonb_agg(jsonb_build_object('country', t.country, 'orders', t.n) order by t.n desc, t.country)
                               from (select country, count(*) as n from scoped s2 where s2.scope = s.scope and country is not null
                                      group by country order by n desc, country limit 25) t), '[]'::jsonb),
      'regions', coalesce((select jsonb_agg(jsonb_build_object('country', t.country, 'province', t.province, 'orders', t.n) order by t.n desc, t.country, t.province)
                             from (select country, province, count(*) as n from scoped s2 where s2.scope = s.scope and country is not null and province is not null
                                    group by country, province order by n desc, country, province limit 25) t), '[]'::jsonb),
      'cities', coalesce((select jsonb_agg(jsonb_build_object('country', t.country, 'city', t.city, 'orders', t.n) order by t.n desc, t.country, t.city)
                            from (select country, city, count(*) as n from scoped s2 where s2.scope = s.scope and country is not null and city is not null
                                   group by country, city order by n desc, country, city limit 25) t), '[]'::jsonb)
    ) as geo
      from scoped s group by scope
  )
  select jsonb_build_object(
    'as_of', p_as_of, 'window_days', p_window_days,
    'store', coalesce((select geo from summary where scope = 'store'), jsonb_build_object('orders', 0, 'with_country', 0, 'countries', '[]'::jsonb, 'regions', '[]'::jsonb, 'cities', '[]'::jsonb)),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'product_id', w.id, 'category_key', w.category_key,
        'product', (select geo from summary where scope = 'product:' || w.id::text),
        'category', case when w.category_key is null then null else (select geo from summary where scope = 'category:' || w.category_key) end)
        order by w.id) from wanted w), '[]'::jsonb)
  );
$$;

revoke all on function public.product_geography_evidence(integer, bigint[], timestamptz, integer) from public, anon, authenticated;
grant execute on function public.product_geography_evidence(integer, bigint[], timestamptz, integer) to service_role;
