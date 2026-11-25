-- Phase 4 finalisation (2026-11-24): what review of the engine asked for (architecture/phase-4-economics.md, "Finalisation").
--
--  - Merchant inputs gain a variant scope, so a zero Shopify unit cost can be confirmed as correct for one variant (or
--    a whole product) and landed costs set per variant; and a 'choice' kind, for when Meta counts a purchase: when
--    the order is placed (a browser pixel at checkout, including unpaid cash-on-delivery orders) or only when it is
--    paid (Omnitarget's Conversions API sends Purchase on orders/paid).
--  - Economics policy version 2: version 1 plus estimate downside, the diagnostic micro-pilot and refund maturity from
--    the store's own refund timing. Still pending approval; version 1 is retired, not deleted.
--  - The evidence counts what became of matured orders: placed, paid, shipped but never paid (failed delivery), and
--    cancelled before shipping, per product and for the store; store_refund_lag measures refund timing.
--  - Tracked campaigns gain a purpose (a test, or a diagnostic micro-pilot whose results never prove acquisition), and
--    each day's exchange rate records its currency pair and the time it applied.

alter table public.economics_input_keys drop constraint economics_input_keys_kind_check;
alter table public.economics_input_keys add constraint economics_input_keys_kind_check check (kind in ('rate', 'money', 'flag', 'choice'));
alter table public.economics_input_keys add column variant_scope boolean not null default false;
update public.economics_input_keys set variant_scope = true where key = 'landed_cost_per_unit';
insert into public.economics_input_keys (key, kind, shop_scope, product_scope, variant_scope, states, min_value, max_value, description) values
  ('unit_cost_zero_confirmed', 'flag', false, true, true, '{merchant_entered}', 1, 1, 'The merchant confirms that a zero Shopify unit cost is correct'),
  ('purchase_event_basis', 'choice', true, false, false, '{merchant_entered}', 0, 1,
   'When Meta counts a purchase: 0 when the order is placed (browser pixel at checkout), 1 only when it is paid (Conversions API on orders/paid)');

alter table public.merchant_economics_inputs add column variant_shopify_id bigint not null default 0 check (variant_shopify_id >= 0);
alter table public.merchant_economics_inputs add constraint merchant_economics_inputs_variant_needs_product check (variant_shopify_id = 0 or product_shopify_id > 0);
alter table public.merchant_economics_inputs drop constraint merchant_economics_inputs_pkey;
alter table public.merchant_economics_inputs add primary key (shop_key, product_shopify_id, variant_shopify_id, key);

create or replace function public.economics_policy_settings_valid(p jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(p) = 'object'
     and (select bool_and(p ? k) from unnest(array[
           'contribution_reserve', 'pilot_conversions', 'test_conversions', 'min_test_conversions', 'scale_step',
           'scale_interval_days', 'min_scale_conversions', 'min_judgement_spend_multiple', 'high_confidence_orders',
           'medium_confidence_orders', 'sales_window_days', 'discount_window_days', 'product_discount_min_orders',
           'product_refund_min_matured_orders', 'store_proxy_min_matured_orders', 'return_maturity_days',
           'established_demand_orders', 'established_demand_window_days', 'proven_conversions', 'acquisition_window_days',
           'attribution_lag_days', 'decision_confidence', 'merchant_inputs_stale_days', 'inventory_stale_hours',
           'inventory_cover_days', 'default_test_days', 'max_test_days', 'material_change_threshold',
           'portfolio_period_days', 'count_incoming_inventory', 'reserve_organic_demand', 'allow_cost_estimates']) as k)
     and (p->>'contribution_reserve')::numeric >= 0 and (p->>'contribution_reserve')::numeric < 1
     and (p->>'scale_step')::numeric > 0 and (p->>'scale_step')::numeric <= 1
     and (p->>'decision_confidence')::numeric >= 0.5 and (p->>'decision_confidence')::numeric < 1
     and (p->>'material_change_threshold')::numeric > 0 and (p->>'material_change_threshold')::numeric < 1
     and (p->>'min_judgement_spend_multiple')::numeric > 0
     and (select bool_and((p->>k)::numeric = trunc((p->>k)::numeric) and (p->>k)::numeric >= 1) from unnest(array[
           'pilot_conversions', 'test_conversions', 'min_test_conversions', 'scale_interval_days', 'min_scale_conversions',
           'high_confidence_orders', 'medium_confidence_orders', 'sales_window_days', 'discount_window_days',
           'product_discount_min_orders', 'product_refund_min_matured_orders', 'store_proxy_min_matured_orders',
           'return_maturity_days', 'established_demand_orders', 'established_demand_window_days', 'proven_conversions',
           'acquisition_window_days', 'attribution_lag_days', 'merchant_inputs_stale_days', 'inventory_stale_hours',
           'inventory_cover_days', 'default_test_days', 'max_test_days', 'portfolio_period_days']) as k)
     and (p->>'min_test_conversions')::numeric <= (p->>'pilot_conversions')::numeric
     and (p->>'pilot_conversions')::numeric <= (p->>'test_conversions')::numeric
     and (p->>'medium_confidence_orders')::numeric <= (p->>'high_confidence_orders')::numeric
     and (p->>'default_test_days')::numeric <= (p->>'max_test_days')::numeric
     and jsonb_typeof(p->'count_incoming_inventory') = 'boolean'
     and jsonb_typeof(p->'reserve_organic_demand') = 'boolean'
     and jsonb_typeof(p->'allow_cost_estimates') = 'boolean'
     -- Version 2 (0056): all or none of its keys, each in range.
     and (not (p ?| array['estimate_downside_factor', 'micro_pilot_min_conversions', 'refund_maturity_min_days', 'refund_maturity_max_days', 'refund_lag_min_refunds'])
          or ((p ?& array['estimate_downside_factor', 'micro_pilot_min_conversions', 'refund_maturity_min_days', 'refund_maturity_max_days', 'refund_lag_min_refunds'])
              and (p->>'estimate_downside_factor')::numeric >= 1 and (p->>'estimate_downside_factor')::numeric <= 3
              and (select bool_and((p->>k)::numeric = trunc((p->>k)::numeric) and (p->>k)::numeric >= 1)
                     from unnest(array['micro_pilot_min_conversions', 'refund_maturity_min_days', 'refund_maturity_max_days', 'refund_lag_min_refunds']) as k)
              and (p->>'micro_pilot_min_conversions')::numeric <= (p->>'min_test_conversions')::numeric
              and (p->>'refund_maturity_min_days')::numeric <= (p->>'refund_maturity_max_days')::numeric));
$$;

update public.economics_policies set status = 'retired' where version = 1;
insert into public.economics_policies (version, settings, rationale, status, activated_at) values (2,
  '{
  "contribution_reserve": 0.3,
  "pilot_conversions": 10,
  "test_conversions": 20,
  "min_test_conversions": 5,
  "scale_step": 0.2,
  "scale_interval_days": 3,
  "min_scale_conversions": 20,
  "min_judgement_spend_multiple": 1.0,
  "high_confidence_orders": 30,
  "medium_confidence_orders": 10,
  "sales_window_days": 365,
  "discount_window_days": 180,
  "product_discount_min_orders": 10,
  "product_refund_min_matured_orders": 20,
  "store_proxy_min_matured_orders": 50,
  "return_maturity_days": 60,
  "established_demand_orders": 10,
  "established_demand_window_days": 180,
  "proven_conversions": 20,
  "acquisition_window_days": 90,
  "attribution_lag_days": 7,
  "decision_confidence": 0.9,
  "merchant_inputs_stale_days": 180,
  "inventory_stale_hours": 48,
  "inventory_cover_days": 7,
  "default_test_days": 14,
  "max_test_days": 30,
  "material_change_threshold": 0.05,
  "portfolio_period_days": 30,
  "count_incoming_inventory": false,
  "reserve_organic_demand": true,
  "allow_cost_estimates": false,
  "estimate_downside_factor": 1.5,
  "micro_pilot_min_conversions": 1,
  "refund_maturity_min_days": 30,
  "refund_maturity_max_days": 120,
  "refund_lag_min_refunds": 20
}'::jsonb,
  '{
  "contribution_reserve": "Share of each sale''s contribution kept, after advertising, towards fixed operating costs and profit. 30% turns a $30 break-even cost per sale into a $21 target.",
  "pilot_conversions": "A pilot is sized to buy this many sales at the target CPA: enough to see whether sales happen, not enough to scale on.",
  "test_conversions": "A controlled test (GO) is sized to buy this many sales at the target CPA, giving a CPA estimate within roughly ±45% at 90%.",
  "min_test_conversions": "Below this many sales at the target CPA a test cannot tell a working product from a failing one, so no budget is recommended.",
  "scale_step": "Largest single budget increase: gradual enough not to reset the platform''s learning, and reversible.",
  "scale_interval_days": "Minimum days between budget increases.",
  "min_scale_conversions": "Matured sales needed before any increase.",
  "min_judgement_spend_multiple": "Matured spend, in break-even CPAs, before a campaign is judged at all.",
  "high_confidence_orders": "Product orders in the sales window for high economics confidence.",
  "medium_confidence_orders": "Product orders in the sales window for medium economics confidence; fewer is low.",
  "sales_window_days": "Detailed orders used for sales, units and variant mix.",
  "discount_window_days": "Recent orders used for the product''s discount rate.",
  "product_discount_min_orders": "Product orders in the discount window before its own discount rate is used.",
  "product_refund_min_matured_orders": "Matured product orders before its own refund rate is used.",
  "store_proxy_min_matured_orders": "Matured store orders before the store-wide rate may stand in for a product''s.",
  "return_maturity_days": "Orders younger than this may still be refunded, so they are left out of refund and return rates.",
  "established_demand_orders": "Product orders that establish demand without campaign results.",
  "established_demand_window_days": "Window for established demand.",
  "proven_conversions": "Matured campaign sales that prove acquisition for a product.",
  "acquisition_window_days": "Window for campaign results.",
  "attribution_lag_days": "Days a conversion may take to be attributed (Meta''s default 7-day click window); younger days are immature.",
  "decision_confidence": "One-sided confidence for pausing, scaling and maximum viable CPA.",
  "merchant_inputs_stale_days": "Merchant inputs older than this lower confidence to medium.",
  "inventory_stale_hours": "Inventory read longer ago than this lowers confidence to medium.",
  "inventory_cover_days": "Days of expected campaign orders the stock must cover.",
  "default_test_days": "Default test length.",
  "max_test_days": "Longest a test may stretch when the daily limit is binding.",
  "material_change_threshold": "A price or cost change beyond this share triggers recalculation.",
  "portfolio_period_days": "Period the monthly advertising limit covers.",
  "count_incoming_inventory": "Incoming stock has no arrival date in Shopify, so it is not counted as sellable.",
  "reserve_organic_demand": "Stock expected to sell without ads during the test is reserved before any is counted for ads.",
  "allow_cost_estimates": "No industry average stands in for a merchant''s cost: each cost is entered or confirmed.",
  "estimate_downside_factor": "Merchant estimates and store-wide stand-ins are stressed by this factor (discounts, refunds, returns and failed deliveries x 1.5; paid share ÷ 1.5 of its shortfall) for the maximum viable cost per sale.",
  "micro_pilot_min_conversions": "Below the minimum test, a diagnostic micro-pilot is offered when it can buy at least this many sales at the target. It never proves acquisition and never scales.",
  "refund_maturity_min_days": "Shortest refund maturity, whatever the store''s refunds suggest.",
  "refund_maturity_max_days": "Longest refund maturity.",
  "refund_lag_min_refunds": "Refunds needed before the store''s own refund timing (90th percentile, in days) sets refund maturity; otherwise return_maturity_days applies."
}'::jsonb,
  'active', now());

create or replace function public.save_economics_inputs(p_shop_key integer, p_inputs jsonb, p_entered_by text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_currency text;
  e record;
  k public.economics_input_keys%rowtype;
  v_saved integer := 0;
  v_cleared integer := 0;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if jsonb_typeof(p_inputs) is distinct from 'array' or jsonb_array_length(p_inputs) > 500 then
    raise exception 'economics_inputs_invalid: an array of at most 500 inputs' using errcode = 'P0001';
  end if;
  if p_entered_by is null or char_length(p_entered_by) not between 1 and 128 then
    raise exception 'economics_inputs_invalid: entered_by' using errcode = 'P0001';
  end if;
  select currency into v_currency from public.shop_settings where shop_key = p_shop_key;

  for e in select coalesce((x->>'product_id')::bigint, 0) as product_id, coalesce((x->>'variant_id')::bigint, 0) as variant_id,
                  x->>'key' as key, x->'value' as value, x->>'state' as state
             from jsonb_array_elements(p_inputs) x loop
    select * into k from public.economics_input_keys where key = e.key;
    if not found then raise exception 'economics_inputs_invalid: unknown key %', e.key using errcode = 'P0001'; end if;
    if e.product_id < 0 or e.variant_id < 0 or (e.product_id = 0 and not k.shop_scope) or (e.product_id > 0 and e.variant_id = 0 and not k.product_scope)
       or (e.variant_id > 0 and (e.product_id = 0 or not k.variant_scope)) then
      raise exception 'economics_inputs_invalid: % is not set at this scope', e.key using errcode = 'P0001';
    end if;
    if e.product_id > 0 and not exists (select 1 from public.products p where p.shop_key = p_shop_key and p.shopify_id = e.product_id) then
      raise exception 'economics_inputs_invalid: the product is not the shop''s' using errcode = 'P0001';
    end if;
    if e.variant_id > 0 and not exists (select 1 from public.product_variants v where v.shop_key = p_shop_key and v.shopify_id = e.variant_id
                                          and v.product_shopify_id = e.product_id) then
      raise exception 'economics_inputs_invalid: the variant is not the product''s' using errcode = 'P0001';
    end if;
    if e.state = 'cleared' then
      delete from public.merchant_economics_inputs
       where shop_key = p_shop_key and product_shopify_id = e.product_id and variant_shopify_id = e.variant_id and key = e.key;
      v_cleared := v_cleared + 1;
      continue;
    end if;
    if e.state is null or not (e.state = any (k.states)) then
      raise exception 'economics_inputs_invalid: % cannot be %', e.key, coalesce(e.state, 'null') using errcode = 'P0001';
    end if;
    if jsonb_typeof(e.value) is distinct from 'number' then
      raise exception 'economics_inputs_invalid: % needs a number', e.key using errcode = 'P0001';
    end if;
    if (e.value)::numeric < k.min_value or (k.max_value is not null and (e.value)::numeric > k.max_value)
       or (e.state = 'confirmed_none' and (e.value)::numeric <> 0)
       or (k.kind = 'flag' and (e.value)::numeric <> 1)
       or (k.kind = 'choice' and (e.value)::numeric <> trunc((e.value)::numeric)) then
      raise exception 'economics_inputs_invalid: % out of range', e.key using errcode = 'P0001';
    end if;
    if k.kind = 'money' and v_currency is null then
      raise exception 'economics_inputs_invalid: the shop''s currency is not known yet' using errcode = 'P0001';
    end if;
    insert into public.merchant_economics_inputs as t (shop_key, product_shopify_id, variant_shopify_id, key, value, state, currency, entered_by, entered_at)
    values (p_shop_key, e.product_id, e.variant_id, e.key, (e.value)::numeric, e.state, case when k.kind = 'money' then v_currency end, p_entered_by, now())
    on conflict (shop_key, product_shopify_id, variant_shopify_id, key) do update set
      value = excluded.value, state = excluded.state, currency = excluded.currency, entered_by = excluded.entered_by, entered_at = now();
    v_saved := v_saved + 1;
  end loop;

  if (select count(*) from public.merchant_economics_inputs where shop_key = p_shop_key) > 20000 then
    raise exception 'economics_inputs_invalid: more than 20,000 inputs for one shop' using errcode = 'P0001';
  end if;
  return jsonb_build_object('saved', v_saved, 'cleared', v_cleared);
end;
$$;

create or replace function public.economics_inputs(p_shop_key integer, p_product_ids bigint[] default '{}')
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'currency', (select currency from public.shop_settings where shop_key = p_shop_key),
    'inputs', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', i.product_shopify_id, 'variant_id', i.variant_shopify_id, 'key', i.key, 'value', i.value, 'state', i.state,
                                          'currency', i.currency, 'entered_by', i.entered_by, 'entered_at', i.entered_at)
                       order by i.product_shopify_id, i.variant_shopify_id, i.key)
        from public.merchant_economics_inputs i
       where i.shop_key = p_shop_key
         and (i.product_shopify_id = 0 or i.product_shopify_id = any (coalesce(p_product_ids[1:1000], '{}')))), '[]'::jsonb));
$$;

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
           coalesce(o.fulfillment_status in ('fulfilled', 'partially_fulfilled', 'partial', 'in_progress', 'restocked'), false) as shipped,
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
    select pl.product_id, pl.order_id, pl.processed_at, pl.paid, pl.shipped, pl.subtotal, pl.total_shipping, pl.total_tax, pl.total_refunded,
           op.products as products_in_order, sum(pl.quantity) as units, sum(pl.gross) as gross, sum(pl.discount) as discount,
           sum(pl.net) as net, array_agg(pl.line_id) as line_ids
      from pl join order_products op on op.order_id = pl.order_id
     group by pl.product_id, pl.order_id, pl.processed_at, pl.paid, pl.shipped, pl.subtotal, pl.total_shipping, pl.total_tax, pl.total_refunded, op.products
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
  -- What became of every matured order placed (0056): paid, shipped but never paid (a failed delivery, e.g. cash on
  -- delivery refused), or neither (cancelled before shipping).
  outcomes as (
    select po.product_id, count(*) as placed, count(*) filter (where po.paid) as paid,
           count(*) filter (where not po.paid and po.shipped) as unpaid_shipped, count(*) filter (where not po.paid and not po.shipped) as unpaid_unshipped
      from po, params where po.processed_at < params.matured_before
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
                                           where r.shop_key = p_shop_key and r.order_shopify_id = o.shopify_id)) as matured_orders_returned,
           count(*) filter (where o.processed_at < params.matured_before) as matured_placed,
           count(*) filter (where o.processed_at < params.matured_before and coalesce(o.financial_status in ('paid', 'partially_refunded', 'refunded'), false)) as matured_paid,
           count(*) filter (where o.processed_at < params.matured_before and not coalesce(o.financial_status in ('paid', 'partially_refunded', 'refunded'), false) and coalesce(o.fulfillment_status in ('fulfilled', 'partially_fulfilled', 'partial', 'in_progress', 'restocked'), false)) as matured_unpaid_shipped
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
                  'refunds_unread', coalesce(ru.refunds, 0), 'returns_unread', coalesce(rr.returns, 0),
                  'placed', coalesce(oc.placed, 0), 'paid', coalesce(oc.paid, 0), 'unpaid_shipped', coalesce(oc.unpaid_shipped, 0),
                  'unpaid_unshipped', coalesce(oc.unpaid_unshipped, 0)),
               'variants', coalesce(vr.entries, '[]'::jsonb),
               'variants_total', coalesce(vr.total, 0),
               'inventory', coalesce(inv.entries, '[]'::jsonb)
             ) order by p.shopify_id)
        from wanted w
        join public.products p on p.shop_key = p_shop_key and p.shopify_id = w.id
        left join sales s on s.product_id = w.id
        left join matured m on m.product_id = w.id
        left join outcomes oc on oc.product_id = w.id
        left join refunded f on f.product_id = w.id
        left join refunds_unread ru on ru.product_id = w.id
        left join returned r on r.product_id = w.id
        left join returns_unread rr on rr.product_id = w.id
        left join variants vr on vr.product_id = w.id
        left join inventory inv on inv.product_id = w.id), '[]'::jsonb));
$$;

-- How long the store's refunds take to arrive (0056): refunds on orders placed in the window, in days from the order
-- to the refund. The engine sets refund maturity from this when there are enough refunds, within the policy's bounds.
create or replace function public.store_refund_lag(p_shop_key integer, p_as_of timestamptz, p_window_days integer)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('refunds', count(*),
           'p90_days', percentile_cont(0.9) within group (order by extract(epoch from (f.processed_at - o.processed_at)) / 86400),
           'p50_days', percentile_cont(0.5) within group (order by extract(epoch from (f.processed_at - o.processed_at)) / 86400))
    from public.refunds f
    join public.orders o on o.shop_key = f.shop_key and o.shopify_id = f.order_shopify_id
   where f.shop_key = p_shop_key and not o.is_test and f.processed_at >= o.processed_at
     and o.processed_at >= p_as_of - make_interval(days => p_window_days) and o.processed_at < p_as_of;
$$;

alter table public.ad_campaigns add column purpose text not null default 'test' check (purpose in ('test', 'diagnostic'));
alter table public.ad_campaign_results add column fx_from text check (fx_from ~ '^[A-Z]{3}$'), add column fx_to text check (fx_to ~ '^[A-Z]{3}$'),
  add column fx_as_of timestamptz;
-- Rows entered before 0056: the pair is the campaign's currency to the shop's, the time when the row was entered.
update public.ad_campaign_results r set fx_from = c.currency, fx_to = coalesce(s.currency, c.currency), fx_as_of = r.entered_at
  from public.ad_campaigns c left join public.shop_settings s on s.shop_key = c.shop_key where c.id = r.campaign_id;
alter table public.ad_campaign_results alter column fx_from set not null, alter column fx_to set not null, alter column fx_as_of set not null;

create or replace function public.save_ad_campaign(p_shop_key integer, p_campaign jsonb, p_by text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := (p_campaign->>'id')::uuid;
  v_products bigint[] := array(select jsonb_array_elements_text(coalesce(p_campaign->'product_ids', '[]'::jsonb))::bigint);
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  if p_by is null or char_length(p_by) not between 1 and 128 then raise exception 'ad_campaign_invalid: created_by' using errcode = 'P0001'; end if;
  if exists (select 1 from unnest(v_products) x(id) where not exists (select 1 from public.products p where p.shop_key = p_shop_key and p.shopify_id = x.id)) then
    raise exception 'ad_campaign_invalid: a product is not the shop''s' using errcode = 'P0001';
  end if;
  if p_campaign->>'recommendation_run_id' is not null and not exists (
       select 1 from public.economics_runs r where r.id = (p_campaign->>'recommendation_run_id')::uuid and r.shop_key = p_shop_key) then
    raise exception 'ad_campaign_invalid: the recommendation run is not the shop''s' using errcode = 'P0001';
  end if;
  if v_id is null then
    insert into public.ad_campaigns (shop_key, name, platform, external_ref, product_ids, status, currency, daily_budget, authorised_budget, max_loss,
      attribution_setting, recommendation_run_id, started_on, ended_on, last_scaled_on, created_by, purpose)
    values (p_shop_key, p_campaign->>'name', coalesce(p_campaign->>'platform', 'meta'), p_campaign->>'external_ref', v_products,
      p_campaign->>'status', p_campaign->>'currency', (p_campaign->>'daily_budget')::numeric, (p_campaign->>'authorised_budget')::numeric,
      (p_campaign->>'max_loss')::numeric, coalesce(p_campaign->>'attribution_setting', '7d_click_1d_view'), (p_campaign->>'recommendation_run_id')::uuid,
      (p_campaign->>'started_on')::date, (p_campaign->>'ended_on')::date, (p_campaign->>'last_scaled_on')::date, p_by,
      coalesce(p_campaign->>'purpose', 'test'))
    returning id into v_id;
  else
    update public.ad_campaigns set name = p_campaign->>'name', platform = coalesce(p_campaign->>'platform', platform), external_ref = p_campaign->>'external_ref',
      product_ids = v_products, status = p_campaign->>'status', currency = p_campaign->>'currency', daily_budget = (p_campaign->>'daily_budget')::numeric,
      authorised_budget = (p_campaign->>'authorised_budget')::numeric, max_loss = (p_campaign->>'max_loss')::numeric,
      attribution_setting = coalesce(p_campaign->>'attribution_setting', attribution_setting),
      recommendation_run_id = (p_campaign->>'recommendation_run_id')::uuid, started_on = (p_campaign->>'started_on')::date,
      ended_on = (p_campaign->>'ended_on')::date, last_scaled_on = (p_campaign->>'last_scaled_on')::date,
      purpose = coalesce(p_campaign->>'purpose', purpose), updated_at = now()
     where id = v_id and shop_key = p_shop_key;
    if not found then raise exception 'ad_campaign_invalid: not the shop''s campaign' using errcode = 'P0001'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.save_ad_campaign_results(p_shop_key integer, p_campaign_id uuid, p_days jsonb, p_by text, p_source text default 'merchant_entered')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.ad_campaigns%rowtype;
  v_shop_currency text;
  v_saved integer;
begin
  perform public.lock_shop_for_ingestion(p_shop_key);
  select * into c from public.ad_campaigns where id = p_campaign_id and shop_key = p_shop_key;
  if not found then raise exception 'ad_results_invalid: not the shop''s campaign' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_days) is distinct from 'array' or jsonb_array_length(p_days) not between 1 and 400 then
    raise exception 'ad_results_invalid: 1 to 400 days' using errcode = 'P0001';
  end if;
  select currency into v_shop_currency from public.shop_settings where shop_key = p_shop_key;
  if v_shop_currency is null then raise exception 'ad_results_invalid: the shop''s currency is not known yet' using errcode = 'P0001'; end if;
  if c.currency = v_shop_currency and exists (select 1 from jsonb_array_elements(p_days) d where (d->>'fx_to_shop')::numeric <> 1) then
    raise exception 'ad_results_invalid: same currency needs a rate of 1' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_days) d where (d->>'day')::date > current_date) then
    raise exception 'ad_results_invalid: a day in the future' using errcode = 'P0001';
  end if;
  -- Every rate says when it applied (0056); the pair is the campaign's currency to the shop's.
  if exists (select 1 from jsonb_array_elements(p_days) d where d->>'fx_as_of' is null or (d->>'fx_as_of')::timestamptz > now()) then
    raise exception 'ad_results_invalid: each day needs the time its exchange rate applied' using errcode = 'P0001';
  end if;
  insert into public.ad_campaign_results as t (campaign_id, shop_key, day, spend, conversions, conversion_value, clicks, impressions, fx_to_shop, fx_source,
    fx_from, fx_to, fx_as_of, source, entered_by, entered_at)
  select p_campaign_id, p_shop_key, (d->>'day')::date, (d->>'spend')::numeric, (d->>'conversions')::integer, (d->>'conversion_value')::numeric,
         (d->>'clicks')::integer, (d->>'impressions')::integer, (d->>'fx_to_shop')::numeric, d->>'fx_source', c.currency, v_shop_currency,
         (d->>'fx_as_of')::timestamptz, p_source, p_by, now()
    from jsonb_array_elements(p_days) d
  on conflict (campaign_id, day) do update set spend = excluded.spend, conversions = excluded.conversions, conversion_value = excluded.conversion_value,
    clicks = excluded.clicks, impressions = excluded.impressions, fx_to_shop = excluded.fx_to_shop, fx_source = excluded.fx_source,
    fx_from = excluded.fx_from, fx_to = excluded.fx_to, fx_as_of = excluded.fx_as_of,
    source = excluded.source, entered_by = excluded.entered_by, entered_at = now();
  get diagnostics v_saved = row_count;
  return jsonb_build_object('saved', v_saved);
end;
$$;

revoke all on function public.store_refund_lag(integer, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.store_refund_lag(integer, timestamptz, integer) to service_role;
