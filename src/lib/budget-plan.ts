/**
 * Merchant-set test budget (Phase S0.6 — BIZ-01/03/04 containment).
 *
 * Omni Target no longer derives ad budgets from store-wide revenue (that rule
 * gave every product in a $78k/month store the same ~$143/day). Until the
 * Phase 4 product-economics engine exists, the only budget figures shown are
 * the merchant's own maximum test spend, split evenly across the test.
 *
 * This module is the single source of every budget number and sentence: the
 * brief view, planner, PDF and plain-text export all render
 * describeBudgetPlan(), and the server recomputes the stored plan from its
 * inputs on save (readBudgetPlan never trusts stored amounts).
 */
import { formatCurrency } from "./currency";

export const BUDGET_PLAN_VERSION = "s0-merchant-cap-v1" as const;
export const BUDGET_TEST_DURATIONS = [7, 14, 30] as const;
export type BudgetTestDuration = (typeof BUDGET_TEST_DURATIONS)[number];

/** Sanity ceiling for a typed amount in any currency's major unit. */
const MAX_TOTAL_BUDGET = 1_000_000_000;
/** Mirrors formatCurrency's zero-decimal display list. */
const ZERO_DECIMAL = new Set(["NGN", "JPY", "KRW", "VND", "IDR", "CLP", "HUF", "UGX", "RWF"]);

export interface BudgetPlan {
  version: typeof BUDGET_PLAN_VERSION;
  basis: "merchant_cap" | "not_set";
  /** Why no recommendation is made. */
  reason: "insufficient_product_evidence";
  currency: string;
  currency_symbol: string | null;
  max_total_budget: number | null;
  duration_days: BudgetTestDuration;
  /** Max total ÷ duration, rounded DOWN so daily × days never exceeds the cap. */
  daily_cap: number | null;
}

export function normalizeTestDuration(value: unknown): BudgetTestDuration {
  const n = Number(value);
  return (BUDGET_TEST_DURATIONS as readonly number[]).includes(n) ? (n as BudgetTestDuration) : 14;
}

/**
 * Parse a merchant-entered amount. Accepts a number, or a plain positive amount
 * typed with an optional leading/trailing currency symbol or code and
 * thousands separators ("₦280,000", "USD 280", "280.50"). Anything else —
 * negatives, exponents, multiple numbers — is rejected rather than coerced.
 */
export function normalizeMaxTotalBudget(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const cleaned = value
      .replace(/[\s,_]/g, "")
      .replace(/^[^\d.\-+]+/, "")
      .replace(/[^\d.]+$/, "");
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    n = Number(cleaned);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n > MAX_TOTAL_BUDGET) return null;
  const rounded = Math.round(n * 100) / 100;
  return rounded > 0 ? rounded : null;
}

export function computeBudgetPlan(input: {
  currency?: string | null;
  currencySymbol?: string | null;
  maxTotalBudget?: unknown;
  durationDays?: unknown;
}): BudgetPlan {
  const currency = /^[A-Z]{3}$/.test(input.currency || "") ? (input.currency as string) : "USD";
  const duration = normalizeTestDuration(input.durationDays);
  const total = normalizeMaxTotalBudget(input.maxTotalBudget);
  let dailyCap: number | null = null;
  if (total !== null) {
    // Integer-cent arithmetic so the split is exact and never rounds above the cap.
    const cents = Math.round(total * 100);
    dailyCap = ZERO_DECIMAL.has(currency)
      ? Math.floor(cents / (duration * 100))
      : Math.floor(cents / duration) / 100;
  }
  const symbol = typeof input.currencySymbol === "string" && /^[^<>"'&]{1,8}$/.test(input.currencySymbol)
    ? input.currencySymbol
    : null;
  return {
    version: BUDGET_PLAN_VERSION,
    basis: total === null ? "not_set" : "merchant_cap",
    reason: "insufficient_product_evidence",
    currency,
    currency_symbol: symbol,
    max_total_budget: total,
    duration_days: duration,
    daily_cap: dailyCap,
  };
}

/** Rebuild a plan from saved brief data, recomputing from its inputs. */
export function readBudgetPlan(
  value: unknown,
  fallbackCurrency?: string | null,
  fallbackSymbol?: string | null,
): BudgetPlan {
  const stored = (value && typeof value === "object" ? value : {}) as Partial<BudgetPlan>;
  return computeBudgetPlan({
    currency: stored.currency ?? fallbackCurrency,
    currencySymbol: stored.currency_symbol ?? fallbackSymbol,
    maxTotalBudget: stored.max_total_budget,
    durationDays: stored.duration_days,
  });
}

/** The merchant's saved maximum test budget from brief context (null = not set). */
export function savedMaxTestBudget(context: unknown): number | null {
  const ctx = (context && typeof context === "object" ? context : {}) as {
    budget_plan?: { max_total_budget?: unknown };
    maxTestBudget?: unknown;
  };
  return normalizeMaxTotalBudget(ctx.budget_plan?.max_total_budget ?? ctx.maxTestBudget ?? null);
}

export interface BudgetPlanText {
  heading: string;
  daily: string;
  total: string;
  duration: string;
  explanation: string;
}

export const WHY_NO_RECOMMENDATION =
  "Omni Target does not recommend an ad budget until there is enough product-level evidence (unit cost, margin and sales history) to justify one.";

/**
 * Budget block the insights engine returns now that revenue-derived budgets
 * are withdrawn: the legacy shape (so saved briefs stay readable) with no
 * amounts, strategies or revenue reasoning.
 */
export function withdrawnEngineBudget(input: {
  currency: string;
  currencySymbol?: string | null;
  optimizationEvent: { event: string; reasoning: string; upgrade_milestone?: string };
}) {
  return {
    status: "withdrawn" as const,
    rule_version: BUDGET_PLAN_VERSION,
    recommended_duration_days: 14,
    reasoning: WHY_NO_RECOMMENDATION,
    currency: input.currency,
    currency_symbol: input.currencySymbol ?? undefined,
    ad_sets: 1,
    ad_set_reasoning: "Run 1 ad set focused on your primary domestic market so the test budget you set is not split.",
    optimization_event: input.optimizationEvent,
    strategies: [] as { label: string; daily: number; total_daily: number; description: string }[],
  };
}

/** The only place budget wording is produced — every surface renders this. */
export function describeBudgetPlan(plan: BudgetPlan): BudgetPlanText {
  const money = (n: number) => formatCurrency(n, plan.currency, plan.currency_symbol ?? undefined);
  if (plan.basis !== "merchant_cap" || plan.max_total_budget === null || plan.daily_cap === null) {
    return {
      heading: "No budget recommendation yet",
      daily: "Not set",
      total: "Not set",
      duration: `${plan.duration_days}-day test`,
      explanation: `${WHY_NO_RECOMMENDATION} Set the maximum you are willing to spend on this test.`,
    };
  }
  return {
    heading: "Your maximum test budget",
    daily: `Up to ${money(plan.daily_cap)}/day`,
    total: `${money(plan.max_total_budget)} maximum over ${plan.duration_days} days`,
    duration: `${plan.duration_days}-day test`,
    explanation: `${WHY_NO_RECOMMENDATION} These figures are the limit you set, split evenly across the test. They are not a performance forecast.`,
  };
}
