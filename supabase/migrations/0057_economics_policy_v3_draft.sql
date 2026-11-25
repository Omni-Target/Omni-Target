-- 0057_economics_policy_v3_draft: economics policy version 3, as a DRAFT (architecture/phase-4-economics.md,
-- "Scaling and pausing thresholds"). Version 2 stays the active policy, pending approval; nothing the engine does
-- changes until version 3 is approved and activated by a later migration.
--  - Separate one-sided confidence for the two campaign decisions: scale_confidence (97.5%) and pause_confidence (95%),
--    replacing one decision_confidence for both (which keeps its role for proportions and the conversion rate).
--  - require_spending_limits: no amount until a test, a daily and a monthly limit are set (CEO decision 2026-11-25).
--  - refund_maturity_min_days 60: the approved 60-day default; the store's refund timing may only lengthen it.

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
              and (p->>'refund_maturity_min_days')::numeric <= (p->>'refund_maturity_max_days')::numeric))
     -- Version 3 (0057): all or none of its keys, only on top of version 2's, each in range.
     and (not (p ?| array['scale_confidence', 'pause_confidence', 'require_spending_limits'])
          or ((p ?& array['scale_confidence', 'pause_confidence', 'require_spending_limits'])
              and p ? 'estimate_downside_factor'
              and (p->>'scale_confidence')::numeric >= 0.5 and (p->>'scale_confidence')::numeric < 1
              and (p->>'pause_confidence')::numeric >= 0.5 and (p->>'pause_confidence')::numeric < 1
              and jsonb_typeof(p->'require_spending_limits') = 'boolean'));
$$;

insert into public.economics_policies (version, settings, rationale, status) values (3,
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
  "refund_maturity_min_days": 60,
  "refund_maturity_max_days": 120,
  "refund_lag_min_refunds": 20,
  "scale_confidence": 0.975,
  "pause_confidence": 0.95,
  "require_spending_limits": true
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
  "decision_confidence": "One-sided confidence for the bounds on proportions (refund, return, paid and failed-delivery rates) and the conversion rate shown beside a campaign. Campaign decisions use scale_confidence and pause_confidence.",
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
  "refund_maturity_min_days": "Shortest refund maturity. 60 days, the approved default: the store''s own refund timing can lengthen it, never shorten it (version 2 allowed 30).",
  "refund_maturity_max_days": "Longest refund maturity.",
  "refund_lag_min_refunds": "Refunds needed before the store''s own refund timing (90th percentile, in days) sets refund maturity; otherwise return_maturity_days applies.",
  "scale_confidence": "Scaling needs the measured cost per sale''s upper bound under break-even at this one-sided confidence. 97.5%: the threshold study (architecture/phase-4-economics.md) found 90% and 95% scale about 1 in 10 and 1 in 11 break-even products under daily checks, and 99% loses 1.4-4.8 profitable scale-ups for each unprofitable one avoided at typical volumes.",
  "pause_confidence": "Pausing needs the measured cost per sale''s lower bound above break-even at this one-sided confidence. 95%: the least strict level that keeps products on target wrongly paused under 1 in 20 when 10% of sales are reported late; with no sale, a campaign pauses after spending 3 times break-even.",
  "require_spending_limits": "No amount is recommended until the merchant has set a maximum per test, a daily limit and a monthly limit. The economics are still shown."
}'::jsonb,
  'draft')
on conflict (version) do nothing;
do $$
begin
  if not exists (select 1 from public.economics_policies where version = 3 and settings = '{
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
  "refund_maturity_min_days": 60,
  "refund_maturity_max_days": 120,
  "refund_lag_min_refunds": 20,
  "scale_confidence": 0.975,
  "pause_confidence": 0.95,
  "require_spending_limits": true
}'::jsonb) then
    raise exception 'economics policy version 3 already exists with different settings';
  end if;
  if not exists (select 1 from public.economics_policies where version = 2 and status = 'active') then
    raise exception 'economics policy version 2 must still be the active policy';
  end if;
end;
$$;
