/** Stored with each brief so explanations never need to reverse-engineer prose. */
export interface BudgetCalculation {
  rule_version: "prespend-v1";
  product_price: number | null;
  price_basis: "selected_product" | "store_aov_or_catalog";
  effective_price: number;
  revenue_30d: number;
  product_revenue_30d: number | null;
  baseline_test_usd: number;
  baseline_duration_days: number;
  baseline_daily: number;
  price_guardrail_daily: number;
  selected_rule: "price_guardrail" | "revenue_tier_baseline";
  daily_before_strategy: number;
  fx: { currency: string; rate: number; source: string; fetched_at: string | null };
}
