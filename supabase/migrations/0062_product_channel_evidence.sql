-- 0062_product_channel_evidence: where a product's buyers came from (Phase 5, task 5; architecture/phase-5-intelligence.md,
-- "Channel fit"). From the order attribution Phase 3 stores (0051): the converting visit's referrer host, UTM source and
-- medium, and visit source, with the order's sales channel and whether it was the customer's first order. No person is
-- identified. Grouped counts, so the rules (src/modules/intelligence/channels.ts) class each group's channel with the
-- same classifier the rest of the app uses. An order whose journey Shopify never recorded (orders created through the API,
-- or read before 0051) is marked so, never counted as direct.

create or replace function public.product_channel_evidence(p_shop_key integer, p_product_ids bigint[], p_as_of timestamptz, p_window_days integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with wanted as (
    select p.shopify_id as id
      from unnest((coalesce(p_product_ids, '{}'))[1:200]) as x(id)
      join public.products p on p.shop_key = p_shop_key and p.shopify_id = x.id
  ),
  paid as (
    select o.shopify_id, o.referrer_host, o.utm_source, o.utm_medium, o.visit_source, o.source_name,
           (o.visit_source is not null or o.referrer_host is not null or o.utm_source is not null) as journey_known,
           (o.customer_order_index = 1) as first_order
      from public.orders o
     where o.shop_key = p_shop_key and not o.is_test
       and o.financial_status in ('paid', 'partially_refunded', 'refunded')
       and o.processed_at > p_as_of - make_interval(days => p_window_days) and o.processed_at <= p_as_of
  ),
  scoped as (
    select 'product:' || w.id::text as scope, o.*
      from wanted w
      join (select distinct li.product_shopify_id, li.order_shopify_id from public.order_line_items li
             where li.shop_key = p_shop_key and li.order_shopify_id in (select shopify_id from paid)) l on l.product_shopify_id = w.id
      join paid o on o.shopify_id = l.order_shopify_id
    union all
    select 'store' as scope, o.* from paid o
  ),
  grouped as (
    select scope, referrer_host, utm_source, utm_medium, visit_source, source_name, journey_known,
           count(*) as orders, count(*) filter (where first_order) as first_orders
      from scoped
     group by scope, referrer_host, utm_source, utm_medium, visit_source, source_name, journey_known
  ),
  summary as (
    select scope, jsonb_build_object(
      'orders', sum(orders),
      'journey_known', coalesce(sum(orders) filter (where journey_known), 0),
      'groups', coalesce((select jsonb_agg(jsonb_build_object('referrer_host', g2.referrer_host, 'utm_source', g2.utm_source, 'utm_medium', g2.utm_medium,
                   'visit_source', g2.visit_source, 'source_name', g2.source_name, 'journey_known', g2.journey_known,
                   'orders', g2.orders, 'first_orders', g2.first_orders) order by g2.orders desc)
                 from (select * from grouped g2 where g2.scope = g.scope order by g2.orders desc limit 200) g2), '[]'::jsonb)
    ) as channels
      from grouped g group by scope
  )
  select jsonb_build_object(
    'as_of', p_as_of, 'window_days', p_window_days,
    'store', coalesce((select channels from summary where scope = 'store'), jsonb_build_object('orders', 0, 'journey_known', 0, 'groups', '[]'::jsonb)),
    'products', coalesce((select jsonb_agg(jsonb_build_object('product_id', w.id,
        'channels', (select channels from summary where scope = 'product:' || w.id::text)) order by w.id) from wanted w), '[]'::jsonb)
  );
$$;

revoke all on function public.product_channel_evidence(integer, bigint[], timestamptz, integer) from public, anon, authenticated;
grant execute on function public.product_channel_evidence(integer, bigint[], timestamptz, integer) to service_role;
