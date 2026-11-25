/**
 * A brief's economics and budget (Phase 4, task 8): the recorded recommendation the engine produced for the
 * brief's product, kept with the brief as a bounded snapshot, and the only wording any surface uses for it
 * (brief view, budget planner, PDF, plain text). Every figure here was computed by the deterministic engine
 * (src/modules/economics) and recorded with its run; nothing is computed or estimated when rendering.
 *
 * Client-safe: no server imports. Briefs saved before Phase 4 have no snapshot and keep their S0.6 plan.
 */
import { getCurrencySymbol } from "./currency";
import { minorUnitExponent } from "@/modules/economics/money";
import type { BudgetPlan, BudgetPlanText } from "./budget-plan";
import { describeBudgetPlan } from "./budget-plan";

export const BRIEF_ECONOMICS_VERSION = 1 as const;
export type BriefVerdict = "GO" | "PILOT" | "DO_NOT_LAUNCH" | "INSUFFICIENT_DATA" | "BLOCKED";
export type BriefBudgetStatus = "recommended" | "zero" | "withheld" | "awaiting_authority";
export type UnavailableReason = "shop_not_connected" | "product_not_identified" | "product_not_in_store_data" | "currency_unknown" | "engine_error";

export interface BriefEconomicsLine { key: string; label: string; amount: number | null; source: string }

export interface BriefEconomics {
  version: typeof BRIEF_ECONOMICS_VERSION;
  status: "computed" | "unavailable";
  unavailable_reason?: UnavailableReason;
  run_id?: string;
  product_id?: number;
  calc_version?: string;
  policy_version?: number;
  computed_at?: string;
  currency?: string;
  verdict?: BriefVerdict;
  reasons?: Array<{ code: string; text: string }>;
  notes?: Array<{ code: string; text: string }>;
  confidence?: { economics: string | null; acquisition: string; overall: string | null; why: string[] };
  unit?: {
    net_revenue: number | null; variable_costs: number | null; contribution: number | null; contribution_margin: number | null;
    break_even_cpa: number | null; maximum_viable_cpa: number | null; target_cpa: number | null;
    break_even_roas: number | null; target_roas: number | null; platform_target_roas: number | null; contribution_upper_bound: number | null;
    /** Policy version 2: break-even per paid order, and when Meta counts a purchase. */
    break_even_cpa_per_paid_order?: number | null; purchase_event_basis?: "placed" | "paid" | "unconfirmed" | null;
  };
  lines?: BriefEconomicsLine[];
  budget?: {
    status: BriefBudgetStatus; kind: "pilot" | "controlled_test" | "micro_pilot" | null; test_budget: number | null; daily_budget: number | null;
    test_days: number | null; max_experimental_loss: number | null; binding: string | null;
    ceilings: Record<"merchant" | "inventory" | "portfolio" | "policy", number | null>; sales_at_target_cpa: number | null;
  };
}

const VERDICTS: BriefVerdict[] = ["GO", "PILOT", "DO_NOT_LAUNCH", "INSUFFICIENT_DATA", "BLOCKED"];
const STATUSES: BriefBudgetStatus[] = ["recommended", "zero", "withheld", "awaiting_authority"];
const UNAVAILABLE: UnavailableReason[] = ["shop_not_connected", "product_not_identified", "product_not_in_store_data", "currency_unknown", "engine_error"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const codes = (v: unknown, max: number) => (Array.isArray(v) ? v : []).slice(0, max)
  .filter((r): r is { code: unknown; text: unknown } => typeof r === "object" && r !== null)
  .map((r) => ({ code: text(r.code, 64), text: text(r.text, 400) })).filter((r) => /^[A-Z_]{2,64}$/.test(r.code));

/** Reads a stored snapshot strictly: anything malformed is dropped rather than rendered. */
export function parseBriefEconomics(value: unknown): BriefEconomics | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== BRIEF_ECONOMICS_VERSION) return null;
  if (v.status === "unavailable") {
    return { version: 1, status: "unavailable", unavailable_reason: UNAVAILABLE.find((r) => r === v.unavailable_reason) ?? "engine_error" };
  }
  if (v.status !== "computed" || !VERDICTS.includes(v.verdict as BriefVerdict) || typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)) return null;
  const u = (v.unit ?? {}) as Record<string, unknown>;
  const b = (v.budget ?? {}) as Record<string, unknown>;
  const ceilings = (b.ceilings ?? {}) as Record<string, unknown>;
  const c = (v.confidence ?? {}) as Record<string, unknown>;
  if (!STATUSES.includes(b.status as BriefBudgetStatus)) return null;
  return {
    version: 1, status: "computed", run_id: text(v.run_id, 64), product_id: num(v.product_id) ?? undefined, calc_version: text(v.calc_version, 32),
    policy_version: num(v.policy_version) ?? undefined, computed_at: text(v.computed_at, 40), currency: v.currency, verdict: v.verdict as BriefVerdict,
    reasons: codes(v.reasons, 20), notes: codes(v.notes, 30),
    confidence: { economics: typeof c.economics === "string" ? c.economics : null, acquisition: text(c.acquisition, 32) || "unproven",
      overall: typeof c.overall === "string" ? c.overall : null, why: (Array.isArray(c.why) ? c.why : []).slice(0, 10).map((w) => text(w, 200)) },
    unit: {
      net_revenue: num(u.net_revenue), variable_costs: num(u.variable_costs), contribution: num(u.contribution), contribution_margin: num(u.contribution_margin),
      break_even_cpa: num(u.break_even_cpa), maximum_viable_cpa: num(u.maximum_viable_cpa), target_cpa: num(u.target_cpa),
      break_even_roas: num(u.break_even_roas), target_roas: num(u.target_roas), platform_target_roas: num(u.platform_target_roas),
      contribution_upper_bound: num(u.contribution_upper_bound),
      // Version 2 only: a snapshot without them (version 1) reads back unchanged.
      ...("purchase_event_basis" in u ? {
        break_even_cpa_per_paid_order: num(u.break_even_cpa_per_paid_order),
        purchase_event_basis: u.purchase_event_basis === "placed" || u.purchase_event_basis === "paid" || u.purchase_event_basis === "unconfirmed" ? u.purchase_event_basis : null,
      } : {}),
    },
    lines: (Array.isArray(v.lines) ? v.lines : []).slice(0, 20).map((l) => {
      const line = (l ?? {}) as Record<string, unknown>;
      return { key: text(line.key, 40), label: text(line.label, 80), amount: num(line.amount), source: text(line.source, 40) };
    }),
    budget: {
      status: b.status as BriefBudgetStatus, kind: b.kind === "pilot" || b.kind === "controlled_test" || b.kind === "micro_pilot" ? b.kind : null,
      test_budget: num(b.test_budget), daily_budget: num(b.daily_budget), test_days: num(b.test_days), max_experimental_loss: num(b.max_experimental_loss),
      binding: typeof b.binding === "string" ? b.binding : null,
      ceilings: { merchant: num(ceilings.merchant), inventory: num(ceilings.inventory), portfolio: num(ceilings.portfolio), policy: num(ceilings.policy) },
      sales_at_target_cpa: num(b.sales_at_target_cpa),
    },
  };
}

/** Money in the currency's own minor unit, never rounded up: a limit shown is never above the limit computed. */
export function formatAmount(amount: number, currency: string): string {
  const digits = minorUnitExponent(currency);
  const scale = 10 ** digits;
  const floored = Math.floor(amount * scale + 1e-6) / scale;
  const whole = Number.isInteger(floored);
  return `${getCurrencySymbol(currency)}${floored.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : digits, maximumFractionDigits: digits })}`;
}

const VERDICT_LABELS: Record<BriefVerdict, string> = {
  GO: "GO: a controlled test is justified",
  PILOT: "PILOT: a small, limited test",
  DO_NOT_LAUNCH: "DO NOT LAUNCH",
  INSUFFICIENT_DATA: "INSUFFICIENT DATA: no recommendation yet",
  BLOCKED: "BLOCKED",
};
const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  shop_not_connected: "Connect your Shopify store so the product's economics can be calculated.",
  product_not_identified: "This brief is not linked to a product in your store, so its economics cannot be calculated.",
  product_not_in_store_data: "The product is not in your synced store data yet.",
  currency_unknown: "Your store's currency is not known yet.",
  engine_error: "The economics could not be calculated just now. No budget is recommended until they are.",
};

export interface BriefEconomicsText extends BudgetPlanText {
  verdict: BriefVerdict | null;
  verdict_label: string;
  /** The per-order figures, labelled. */
  figures: Array<[string, string]>;
  reasons: string[];
  notes: string[];
}

/** The only wording for a brief's economics and budget. */
export function describeBriefEconomics(e: BriefEconomics): BriefEconomicsText {
  if (e.status === "unavailable" || !e.currency || !e.verdict || !e.budget || !e.unit) {
    const why = UNAVAILABLE_TEXT[e.unavailable_reason ?? "engine_error"];
    return { heading: "No budget recommendation", daily: "Not available", total: "Not available", duration: "Not set", explanation: why,
      verdict: null, verdict_label: "Not calculated", figures: [], reasons: [why], notes: [] };
  }
  const money = (n: number | null) => (n === null ? "Unknown" : formatAmount(n, e.currency as string));
  const b = e.budget;
  const u = e.unit;
  const figures: Array<[string, string]> = u.contribution !== null ? [
    ["Net revenue per order", money(u.net_revenue)],
    ["Variable costs per order", money(u.variable_costs)],
    ["Contribution before advertising", money(u.contribution)],
    ["Contribution margin", u.contribution_margin === null ? "Unknown" : `${(u.contribution_margin * 100).toFixed(1)}%`],
    ["Break-even cost per sale", money(u.break_even_cpa)],
    ...(u.break_even_cpa_per_paid_order != null && u.break_even_cpa_per_paid_order !== u.break_even_cpa
      ? [["Break-even per paid order", money(u.break_even_cpa_per_paid_order)] as [string, string]] : []),
    ...(u.purchase_event_basis ? [["Purchases counted", u.purchase_event_basis === "paid" ? "when paid"
      : u.purchase_event_basis === "placed" ? "when placed" : "not confirmed (lower break-even used)"] as [string, string]] : []),
    ["Target cost per sale", money(u.target_cpa)],
    ["Break-even ROAS", u.break_even_roas === null ? "Not applicable" : `${u.break_even_roas.toFixed(2)}`],
    ["Target ROAS", u.target_roas === null ? "Not applicable" : `${u.target_roas.toFixed(2)}`],
  ] : u.contribution_upper_bound !== null ? [["Most contribution could be, from known figures", money(u.contribution_upper_bound)]] : [];
  const reasons = (e.reasons ?? []).map((r) => r.text);
  const notes = (e.notes ?? []).map((r) => r.text);
  const base = { verdict: e.verdict, verdict_label: VERDICT_LABELS[e.verdict], figures, reasons, notes };
  const limits = "These are limits, not a forecast: a daily budget is not a guaranteed platform spend, and the target is not a predicted cost per sale.";

  switch (b.status) {
    case "recommended": {
      const kind = b.kind === "controlled_test" ? "Controlled test" : b.kind === "micro_pilot" ? "Diagnostic micro-pilot" : "Pilot";
      return { ...base, heading: `${kind}: up to ${money(b.test_budget)} over ${b.test_days} days`,
        daily: `Up to ${money(b.daily_budget)}/day`, total: `${money(b.test_budget)} maximum over ${b.test_days} days`, duration: `${b.test_days}-day test`,
        explanation: `Sized to buy about ${b.sales_at_target_cpa} sales at the ${money(u.target_cpa)} target cost per sale, within your limits`
          + `${b.binding ? ` (set by the ${b.binding === "policy" ? "test-size policy" : `${b.binding} limit`})` : ""}. `
          + `Stop if losses reach ${money(b.max_experimental_loss)}. `
          + (b.kind === "micro_pilot" ? "This is a diagnostic test of traffic, creative and first sales: too small to prove profitable acquisition, and never a reason to scale. " : "")
          + `The target keeps part of each sale's contribution towards fixed costs and profit. ${limits}` };
    }
    case "zero":
      return { ...base, heading: e.verdict === "BLOCKED" ? "Advertising blocked" : e.verdict === "DO_NOT_LAUNCH" ? "Do not launch: no budget" : "No budget for now",
        daily: formatAmount(0, e.currency), total: formatAmount(0, e.currency), duration: "No test", explanation: [...reasons, ...notes.slice(0, 2)].join(" ") };
    case "awaiting_authority": {
      // Policy version 3 names each limit still to set (test, daily, monthly); earlier versions ask for the test limit.
      const LIMIT_NAMES: Record<string, string> = { TEST_LIMIT_MISSING: "the most you will spend on this test",
        DAILY_LIMIT_MISSING: "a daily limit", MONTHLY_LIMIT_MISSING: "a monthly limit" };
      const missing = (e.notes ?? []).map((n) => LIMIT_NAMES[n.code]).filter((n): n is string => !!n);
      const ask = missing.length
        ? `Omnitarget recommends no amount until you set ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0]}.`
        : "Omnitarget recommends no amount until you set the most you will spend on this test.";
      return { ...base, heading: missing.length > 1 ? "Set your spending limits to get a budget" : "Set your spending limit to get a budget",
        daily: "Not set", total: "Not set", duration: "Not set",
        explanation: `The economics support a ${b.kind === "controlled_test" ? "controlled test" : "pilot"} at a ${money(u.target_cpa)} target cost per sale. ${ask}` };
    }
    default:
      return { ...base, heading: "No budget recommendation yet", daily: "Withheld", total: "Withheld", duration: "Not set",
        explanation: `${reasons.join(" ")} No figure is estimated in its place.` };
  }
}

/** The budget wording for any brief: its recorded economics when it has them, else its S0.6 plan (briefs saved before Phase 4). */
export function describeBriefBudget(plan: BudgetPlan, economics: BriefEconomics | null | undefined): BudgetPlanText {
  return economics ? describeBriefEconomics(economics) : describeBudgetPlan(plan);
}
