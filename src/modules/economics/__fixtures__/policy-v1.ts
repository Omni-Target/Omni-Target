import type { EconomicsPolicy } from "../policy";

/**
 * Test fixture: a copy of economics policy version 1 as migration 0052 writes it.
 * policy.test.ts reads the migration and requires this copy to match, so unit
 * tests run against the real defaults without a database.
 */
export const POLICY_V1: EconomicsPolicy = {
  version: 1,
  approval: "pending",
  settings: {
    contribution_reserve: 0.3,
    pilot_conversions: 10, test_conversions: 20, min_test_conversions: 5,
    scale_step: 0.2, scale_interval_days: 3, min_scale_conversions: 20, min_judgement_spend_multiple: 1,
    high_confidence_orders: 30, medium_confidence_orders: 10,
    sales_window_days: 365, discount_window_days: 180, product_discount_min_orders: 10,
    product_refund_min_matured_orders: 20, store_proxy_min_matured_orders: 50, return_maturity_days: 60,
    established_demand_orders: 10, established_demand_window_days: 180,
    proven_conversions: 20, acquisition_window_days: 90, attribution_lag_days: 7, decision_confidence: 0.9,
    merchant_inputs_stale_days: 180, inventory_stale_hours: 48, inventory_cover_days: 7,
    default_test_days: 14, max_test_days: 30, material_change_threshold: 0.05, portfolio_period_days: 30,
    count_incoming_inventory: false, reserve_organic_demand: true, allow_cost_estimates: false,
  },
};
