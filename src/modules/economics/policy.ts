/**
 * The economics policy (Phase 4, task 2; migration 0052). PostgreSQL holds the
 * versioned policy; this module types it and checks a version before the
 * engine uses it, with the same rules as economics_policy_settings_valid.
 * The engine never carries defaults of its own: every threshold comes from a
 * stored version, and every recommendation records which.
 */
export interface EconomicsPolicySettings {
  contribution_reserve: number;
  pilot_conversions: number;
  test_conversions: number;
  min_test_conversions: number;
  scale_step: number;
  scale_interval_days: number;
  min_scale_conversions: number;
  min_judgement_spend_multiple: number;
  high_confidence_orders: number;
  medium_confidence_orders: number;
  sales_window_days: number;
  discount_window_days: number;
  product_discount_min_orders: number;
  product_refund_min_matured_orders: number;
  store_proxy_min_matured_orders: number;
  return_maturity_days: number;
  established_demand_orders: number;
  established_demand_window_days: number;
  proven_conversions: number;
  acquisition_window_days: number;
  attribution_lag_days: number;
  decision_confidence: number;
  merchant_inputs_stale_days: number;
  inventory_stale_hours: number;
  inventory_cover_days: number;
  default_test_days: number;
  max_test_days: number;
  material_change_threshold: number;
  portfolio_period_days: number;
  count_incoming_inventory: boolean;
  reserve_organic_demand: boolean;
  allow_cost_estimates: boolean;
  /** Version 2 (migration 0056); absent in version 1, whose records recompute unchanged. */
  estimate_downside_factor?: number;
  micro_pilot_min_conversions?: number;
  refund_maturity_min_days?: number;
  refund_maturity_max_days?: number;
  refund_lag_min_refunds?: number;
  /**
   * Version 3 (migration 0057, draft): separate confidence for the two campaign decisions. Scaling needs the
   * measured cost per sale's upper bound under break-even at scale_confidence; pausing needs its lower bound above
   * break-even at pause_confidence. Absent: both use decision_confidence, as in versions 1 and 2.
   */
  scale_confidence?: number;
  pause_confidence?: number;
  /** Version 3: no amount is recommended until the merchant has set a test, a daily and a monthly limit. */
  require_spending_limits?: boolean;
}

export interface EconomicsPolicy {
  version: number;
  settings: EconomicsPolicySettings;
  approval: "pending" | "approved";
}

const WHOLE = [
  "pilot_conversions", "test_conversions", "min_test_conversions", "scale_interval_days", "min_scale_conversions",
  "high_confidence_orders", "medium_confidence_orders", "sales_window_days", "discount_window_days",
  "product_discount_min_orders", "product_refund_min_matured_orders", "store_proxy_min_matured_orders",
  "return_maturity_days", "established_demand_orders", "established_demand_window_days", "proven_conversions",
  "acquisition_window_days", "attribution_lag_days", "merchant_inputs_stale_days", "inventory_stale_hours",
  "inventory_cover_days", "default_test_days", "max_test_days", "portfolio_period_days",
] as const satisfies readonly (keyof EconomicsPolicySettings)[];
const FLAGS = ["count_incoming_inventory", "reserve_organic_demand", "allow_cost_estimates"] as const satisfies readonly (keyof EconomicsPolicySettings)[];
const RANGES: Partial<Record<keyof EconomicsPolicySettings, [number, number, "closed" | "open-max"]>> = {
  contribution_reserve: [0, 1, "open-max"],
  scale_step: [Number.MIN_VALUE, 1, "closed"],
  decision_confidence: [0.5, 1, "open-max"],
  material_change_threshold: [Number.MIN_VALUE, 1, "open-max"],
  min_judgement_spend_multiple: [Number.MIN_VALUE, Number.MAX_VALUE, "closed"],
};

/** Checks a stored policy version; throws with the first problem found. */
export function parseEconomicsPolicy(raw: unknown): EconomicsPolicy {
  const row = (raw ?? {}) as { version?: unknown; settings?: Record<string, unknown>; approval?: unknown };
  const s = row.settings ?? {};
  const fail = (why: string): never => { throw new Error(`economics policy ${String(row.version)} invalid: ${why}`); };
  if (!Number.isInteger(row.version) || (row.version as number) < 1) fail("version");
  for (const key of WHOLE) {
    const v = s[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fail(key);
  }
  for (const key of FLAGS) if (typeof s[key] !== "boolean") fail(key);
  for (const [key, [min, max, kind]] of Object.entries(RANGES) as [keyof EconomicsPolicySettings, [number, number, string]][]) {
    const v = s[key];
    if (typeof v !== "number" || v < min || (kind === "open-max" ? v >= max : v > max)) fail(key);
  }
  const n = (key: string) => s[key] as number;
  if (n("min_test_conversions") > n("pilot_conversions") || n("pilot_conversions") > n("test_conversions")) fail("test sizes out of order");
  if (n("medium_confidence_orders") > n("high_confidence_orders")) fail("confidence thresholds out of order");
  if (n("default_test_days") > n("max_test_days")) fail("test days out of order");
  // Version 2's keys: all or none, each in range (as economics_policy_settings_valid, 0056).
  const v2Keys = ["estimate_downside_factor", "micro_pilot_min_conversions", "refund_maturity_min_days", "refund_maturity_max_days", "refund_lag_min_refunds"];
  if (v2Keys.some((k) => k in s)) {
    for (const k of v2Keys) if (!(k in s)) fail(k);
    if (!(n("estimate_downside_factor") >= 1 && n("estimate_downside_factor") <= 3)) fail("estimate_downside_factor");
    for (const k of v2Keys.slice(1)) if (!Number.isInteger(s[k]) || n(k) < 1) fail(k);
    if (n("micro_pilot_min_conversions") > n("min_test_conversions")) fail("micro_pilot_min_conversions");
    if (n("refund_maturity_min_days") > n("refund_maturity_max_days")) fail("refund maturity bounds out of order");
  }
  // Version 3's keys: all or none, and only on top of version 2's (as economics_policy_settings_valid, 0057).
  const v3Keys = ["scale_confidence", "pause_confidence", "require_spending_limits"];
  if (v3Keys.some((k) => k in s)) {
    for (const k of v3Keys) if (!(k in s)) fail(k);
    if (!v2Keys.every((k) => k in s)) fail("version 3 settings need version 2's");
    for (const k of ["scale_confidence", "pause_confidence"]) if (typeof s[k] !== "number" || n(k) < 0.5 || n(k) >= 1) fail(k);
    if (typeof s.require_spending_limits !== "boolean") fail("require_spending_limits");
  }
  if (row.approval !== "pending" && row.approval !== "approved") fail("approval");
  return { version: row.version as number, settings: s as unknown as EconomicsPolicySettings, approval: row.approval as "pending" | "approved" };
}
