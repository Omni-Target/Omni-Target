-- Phase 4, task 3: the evidence the economics engine needs, aggregated in the database
-- (architecture/phase-4-economics.md, "Contribution per acquired order").
--
-- product_economics_evidence returns, for at most 200 products, everything the contribution formulas read,
-- as observed in the mirror, with the windows the policy sets (passed in, so a recommendation can record and
-- reproduce them):
--  - the product: status, gift card, Shopify Collective, published online, when it was read;
--  - its variants (at most 250, sold ones first): current price, unit cost and its currency, tracking,
--    overselling policy, shipping, and units sold in the sales window (the variant mix);
--  - sales in the window, from orders whose money was collected (paid, partially refunded, refunded):
--    orders, units, gross, line discounts, net; recent and demand-window units; orders created but not paid (an
--    order without a financial status counts as not paid: its money is not known to have been collected);
--  - discounts over the discount window;
--  - customer-paid shipping: on orders holding only this product, and allocated by line value on orders holding
--    others; shipping on orders with any refund is left out (it may have been refunded);
--  - tax allocated to the product's lines by value (order tax × line net ÷ (subtotal + shipping));
--  - over matured orders only (processed before the maturity cut-off): refunded amount, refunded and restocked
--    units by restock type, orders refunded, returns and returned units. While any refund on those orders has
--    unread lines, or any return was read before Phase 3's fields, the refund or return figures are withheld
--    (null), not guessed;
--  - inventory per variant from Phase 3's inventory_availability (online availability, state, unknown
--    locations), without location detail;
--  - store-wide rates from orders over the same windows, for a product without enough history of its own
--    (paid and unpaid orders, tax and its base, discounts, matured totals, refunds and returns);
--  - freshness: when each synced domain was last complete (import checkpoint or reconcile watermark).
-- Test orders are excluded everywhere. Money is in the shop's currency (Shopify's shop money).

create or replace function public.product_economics_evidence(
  p_shop_key integer, p_product_ids bigint[], p_as_of timestamptz,
  p_sales_window_days integer, p_discount_window_days integer, p_maturity_days integer, p_demand_window_days integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with params as (
    select p_as_of as as_of,
           p_as_of - make_interval(days => p_sales_window_days) as sales_from,
           p_as_of - make_interval(days => p_discount_window_days) as discount_from,
           p_as_of - make_interval(days => p_maturity_days) as matured_before,
           p_as_of - make_interval(days => p_demand_window_days) as demand_from,
           p_as_of - interval '30 days' as recent_from
  ),
  wanted as (
    select distinct p.shopify_id as id
      from unnest((coalesce(p_product_ids, '{}'))[1:200]) as x(id)
      join public.products p on p.shop_key = p_shop_key and p.shopify_id = x.id
  ),
  -- The wanted products' lines on non-test orders in the sales window, with their order.
  pl as (
    select li.product_shopify_id as product_id, li.variant_shopify_id as variant_id, li.shopify_id as line_id, li.quantity,
           li.unit_price * li.quantity as gross, coalesce(li.total_discount, 0) as discount,
           li.unit_price * li.quantity - coalesce(li.total_discount, 0) as net,
           o.shopify_id as order_id, o.processed_at, coalesce(o.financial_status in ('paid', 'partially_refunded', 'refunded'), false) as paid,
           coalesce(o.subtotal, 0) as subtotal, coalesce(o.total_shipping, 0) as total_shipping, coalesce(o.total_tax, 0) as total_tax,
           coalesce(o.total_refunded, 0) as total_refunded
      from params, public.order_line_items li
      join wanted w on w.id = li.product_shopify_id
      join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
     where li.shop_key = p_shop_key and li.quantity > 0 and not o.is_test
       and o.processed_at >= params.sales_from and o.processed_at < params.as_of
  ),
  -- How many distinct products each of those orders holds.
  order_products as (
    select li.order_shopify_id as order_id, count(distinct li.product_shopify_id) as products
      from public.order_line_items li
     where li.shop_key = p_shop_key and li.quantity > 0 and li.order_shopify_id in (select distinct order_id from pl)
     group by li.order_shopify_id
  ),
  -- One row per product and order.
  po as (
    select pl.product_id, pl.order_id, pl.processed_at, pl.paid, pl.subtotal, pl.total_shipping, pl.total_tax, pl.total_refunded,
           op.products as products_in_order, sum(pl.quantity) as units, sum(pl.gross) as gross, sum(pl.discount) as discount,
           sum(pl.net) as net, array_agg(pl.line_id) as line_ids
      from pl join order_products op on op.order_id = pl.order_id
     group by pl.product_id, pl.order_id, pl.processed_at, pl.paid, pl.subtotal, pl.total_shipping, pl.total_tax, pl.total_refunded, op.products
  ),
  sales as (
    select po.product_id,
           count(*) as orders_created,
           count(*) filter (where po.paid) as orders,
           count(*) filter (where not po.paid) as orders_unpaid,
           coalesce(sum(po.units) filter (where po.paid), 0) as units,
           coalesce(sum(po.gross) filter (where po.paid), 0) as gross,
           coalesce(sum(po.discount) filter (where po.paid), 0) as discounts,
           coalesce(sum(po.net) filter (where po.paid), 0) as net,
           min(po.processed_at) filter (where po.paid) as first_order_at,
           max(po.processed_at) filter (where po.paid) as last_order_at,
           count(*) filter (where po.paid and po.processed_at >= params.demand_from) as demand_orders,
           coalesce(sum(po.units) filter (where po.paid and po.processed_at >= params.demand_from), 0) as demand_units,
           coalesce(sum(po.units) filter (where po.paid and po.processed_at >= params.recent_from), 0) as recent_units,
           count(*) filter (where po.paid and po.processed_at >= params.discount_from) as discount_orders,
           coalesce(sum(po.gross) filter (where po.paid and po.processed_at >= params.discount_from), 0) as discount_gross,
           coalesce(sum(po.discount) filter (where po.paid and po.processed_at >= params.discount_from), 0) as discount_amount,
           count(*) filter (where po.paid and po.products_in_order = 1) as single_orders,
           count(*) filter (where po.paid and po.products_in_order = 1 and po.total_refunded = 0) as single_orders_unrefunded,
           coalesce(sum(po.total_shipping) filter (where po.paid and po.products_in_order = 1 and po.total_refunded = 0), 0) as single_shipping,
           count(*) filter (where po.paid and po.products_in_order > 1) as multi_orders,
           count(*) filter (where po.paid and po.products_in_order > 1 and po.total_refunded = 0) as multi_orders_unrefunded,
           coalesce(sum(case when po.subtotal > 0 then po.total_shipping * po.net / po.subtotal else 0 end)
                      filter (where po.paid and po.products_in_order > 1 and po.total_refunded = 0), 0) as multi_shipping_allocated,
           count(*) filter (where po.paid and po.total_tax > 0) as orders_with_tax,
           coalesce(sum(case when po.subtotal + po.total_shipping > 0 then po.total_tax * po.net / (po.subtotal + po.total_shipping) else 0 end)
                      filter (where po.paid), 0) as allocated_tax
      from po, params
     group by po.product_id
  ),
  matured as (
    select po.product_id, count(*) as orders, sum(po.units) as units, sum(po.net) as net
      from po, params where po.paid and po.processed_at < params.matured_before
     group by po.product_id
  ),
  matured_lines as (
    select po.product_id, po.order_id, unnest(po.line_ids) as line_id
      from po, params where po.paid and po.processed_at < params.matured_before
  ),
  refunded as (
    select ml.product_id, coalesce(sum(fl.subtotal), 0) as amount, sum(fl.quantity) as units,
           coalesce(sum(fl.quantity) filter (where fl.restock_type in ('return', 'legacy_restock')), 0) as returned_restocked_units,
           coalesce(sum(fl.quantity) filter (where fl.restock_type = 'cancel'), 0) as cancelled_restocked_units,
           count(distinct ml.order_id) as orders
      from matured_lines ml
      join public.refund_line_items fl on fl.shop_key = p_shop_key and fl.line_item_shopify_id = ml.line_id
     where fl.quantity > 0
     group by ml.product_id
  ),
  refunds_unread as (
    select m.product_id, count(distinct f.shopify_id) as refunds
      from (select distinct product_id, order_id from matured_lines) m
      join public.refunds f on f.shop_key = p_shop_key and f.order_shopify_id = m.order_id
     where not f.lines_read
     group by m.product_id
  ),
  returned as (
    select ml.product_id, count(distinct r.return_shopify_id) as returns, sum(r.quantity) as units
      from matured_lines ml
      join public.return_line_items r on r.shop_key = p_shop_key and r.line_item_shopify_id = ml.line_id
     group by ml.product_id
  ),
  returns_unread as (
    select m.product_id, count(distinct r.shopify_id) as returns
      from (select distinct product_id, order_id from matured_lines) m
      join public.returns r on r.shop_key = p_shop_key and r.order_shopify_id = m.order_id
     where r.fields_version is null
     group by m.product_id
  ),
  variant_sales as (
    select pl.variant_id, sum(pl.quantity) as units, count(distinct pl.order_id) as orders
      from pl where pl.paid group by pl.variant_id
  ),
  variants as (
    select ranked.product_id, count(*) as total,
           jsonb_agg(ranked.entry order by ranked.rank) filter (where ranked.rank <= 250) as entries
      from (
        select v.product_shopify_id as product_id,
               row_number() over (partition by v.product_shopify_id order by coalesce(vs.units, 0) desc, v.position nulls last, v.shopify_id) as rank,
               jsonb_build_object('id', v.shopify_id, 'title', v.title, 'price', v.price, 'compare_at_price', v.compare_at_price,
                 'unit_cost', v.unit_cost, 'unit_cost_currency', v.unit_cost_currency, 'tracked', v.tracked,
                 'inventory_policy', v.inventory_policy, 'requires_shipping', v.requires_shipping, 'available_for_sale', v.available_for_sale,
                 'units', coalesce(vs.units, 0), 'orders', coalesce(vs.orders, 0), 'synced_at', v.synced_at) as entry
          from public.product_variants v
          join wanted w on w.id = v.product_shopify_id
          left join variant_sales vs on vs.variant_id = v.shopify_id
         where v.shop_key = p_shop_key
      ) ranked
     group by ranked.product_id
  ),
  -- Phase 3's availability for the variants listed (at most 250 per product), without location detail.
  inventory as (
    select w.id as product_id,
           (select coalesce(jsonb_agg(a - 'locations'), '[]'::jsonb)
              from jsonb_array_elements(public.inventory_availability(p_shop_key,
                     array(select (e->>'id')::bigint from jsonb_array_elements(coalesce(vr.entries, '[]'::jsonb)) e))) a) as entries
      from wanted w left join variants vr on vr.product_id = w.id
  ),
  -- Store-wide rates from orders over the same windows: for a product without enough history of its own.
  store as (
    select count(*) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded')) as orders,
           coalesce(sum(o.total_tax) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded')), 0) as tax_amount,
           coalesce(sum(o.subtotal + o.total_shipping) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded')), 0) as tax_base,
           count(*) filter (where coalesce(o.financial_status not in ('paid', 'partially_refunded', 'refunded'), true)) as orders_unpaid,
           count(*) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded') and o.processed_at >= params.discount_from) as discount_orders,
           coalesce(sum(o.total_discounts) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded') and o.processed_at >= params.discount_from), 0) as discount_amount,
           coalesce(sum(o.subtotal + o.total_discounts) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded') and o.processed_at >= params.discount_from), 0) as discount_gross,
           count(*) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded') and o.processed_at < params.matured_before) as matured_orders,
           coalesce(sum(o.total_price) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded') and o.processed_at < params.matured_before), 0) as matured_total,
           coalesce(sum(o.total_refunded) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded') and o.processed_at < params.matured_before), 0) as matured_refunded,
           count(*) filter (where o.financial_status in ('paid', 'partially_refunded', 'refunded') and o.processed_at < params.matured_before
                              and exists (select 1 from public.return_line_items rl join public.returns r on r.shop_key = rl.shop_key and r.shopify_id = rl.return_shopify_id
                                           where r.shop_key = p_shop_key and r.order_shopify_id = o.shopify_id)) as matured_orders_returned
      from params, public.orders o
     where o.shop_key = p_shop_key and not o.is_test and o.processed_at >= params.sales_from and o.processed_at < params.as_of
  )
  select jsonb_build_object(
    'as_of', p_as_of,
    'params', jsonb_build_object('sales_window_days', p_sales_window_days, 'discount_window_days', p_discount_window_days,
                                 'maturity_days', p_maturity_days, 'demand_window_days', p_demand_window_days, 'recent_days', 30),
    'currency', (select currency from public.shop_settings where shop_key = p_shop_key),
    'taxes_included', (select taxes_included from public.shop_settings where shop_key = p_shop_key),
    'freshness', coalesce((select jsonb_object_agg(c.domain, greatest(c.watermark, nullif(c.updated_at, '-infinity')))
                             from public.sync_checkpoints c where c.shop_key = p_shop_key), '{}'::jsonb),
    'store', (select to_jsonb(store) from store),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', p.shopify_id,
               'product', jsonb_build_object('title', p.title, 'status', p.status, 'is_gift_card', p.is_gift_card,
                            'collective', coalesce('Shopify Collective' = any (p.tags), false), 'online_store_url', p.online_store_url,
                            'published_at', p.published_at, 'requires_selling_plan', p.requires_selling_plan, 'fields_version', p.fields_version,
                            'created_at', p.shopify_created_at, 'synced_at', p.synced_at),
               'sales', coalesce(to_jsonb(s) - 'product_id', jsonb_build_object('orders', 0, 'orders_created', 0, 'orders_unpaid', 0, 'units', 0,
                          'gross', 0, 'discounts', 0, 'net', 0, 'demand_orders', 0, 'demand_units', 0, 'recent_units', 0, 'discount_orders', 0,
                          'discount_gross', 0, 'discount_amount', 0, 'single_orders', 0, 'single_orders_unrefunded', 0, 'single_shipping', 0,
                          'multi_orders', 0, 'multi_orders_unrefunded', 0, 'multi_shipping_allocated', 0, 'orders_with_tax', 0, 'allocated_tax', 0)),
               'matured', jsonb_build_object(
                  'orders', coalesce(m.orders, 0), 'units', coalesce(m.units, 0), 'net', coalesce(m.net, 0),
                  -- Withheld while refund lines are unread, never guessed.
                  'refunded_amount', case when ru.refunds is null then coalesce(f.amount, 0) end,
                  'refunded_units', case when ru.refunds is null then coalesce(f.units, 0) end,
                  'returned_restocked_units', case when ru.refunds is null then coalesce(f.returned_restocked_units, 0) end,
                  'cancelled_restocked_units', case when ru.refunds is null then coalesce(f.cancelled_restocked_units, 0) end,
                  'orders_refunded', case when ru.refunds is null then coalesce(f.orders, 0) end,
                  'returns', case when rr.returns is null then coalesce(r.returns, 0) end,
                  'returned_units', case when rr.returns is null then coalesce(r.units, 0) end,
                  'refunds_unread', coalesce(ru.refunds, 0), 'returns_unread', coalesce(rr.returns, 0)),
               'variants', coalesce(vr.entries, '[]'::jsonb),
               'variants_total', coalesce(vr.total, 0),
               'inventory', coalesce(inv.entries, '[]'::jsonb)
             ) order by p.shopify_id)
        from wanted w
        join public.products p on p.shop_key = p_shop_key and p.shopify_id = w.id
        left join sales s on s.product_id = w.id
        left join matured m on m.product_id = w.id
        left join refunded f on f.product_id = w.id
        left join refunds_unread ru on ru.product_id = w.id
        left join returned r on r.product_id = w.id
        left join returns_unread rr on rr.product_id = w.id
        left join variants vr on vr.product_id = w.id
        left join inventory inv on inv.product_id = w.id), '[]'::jsonb));
$$;

revoke all on function public.product_economics_evidence(integer, bigint[], timestamptz, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.product_economics_evidence(integer, bigint[], timestamptz, integer, integer, integer, integer)
  to service_role;
