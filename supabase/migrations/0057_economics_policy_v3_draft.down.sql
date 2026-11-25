-- Reverts 0057_economics_policy_v3_draft.sql. A draft version 3 is removed. Had it been activated, it is retired and
-- kept (recommendations recorded under it reference it), and version 2 becomes active again. The version 2 validator
-- comes back.

update public.economics_policies set status = 'retired' where version = 3 and status = 'active';
update public.economics_policies set status = 'active' where version = 2
   and not exists (select 1 from public.economics_policies where status = 'active');
delete from public.economics_policies where version = 3 and status = 'draft';

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
