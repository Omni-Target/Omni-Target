/**
 * The bounded snapshot of a recorded recommendation that a brief keeps (Phase 4, task 8). Every figure is the
 * engine's own, copied, not recomputed; each reason carries its plain-language text from the catalogue.
 */
import { BRIEF_ECONOMICS_VERSION, type BriefEconomics, type UnavailableReason } from "@/lib/brief-economics";
import { COST_LINES, REVENUE_LINES, type LineKey } from "./contribution";
import { REASONS, isReason } from "./reasons";
import type { ProductRecommendation } from "./recommend";

const LABELS: Record<LineKey, string> = {
  gross_revenue: "Gross product revenue", discounts: "Discounts", refunds: "Expected refunds", tax_included: "Tax inside prices",
  shipping_revenue: "Shipping paid by the customer", net_revenue: "Net revenue per order", product_cost: "Product cost (unit cost)",
  landed_cost: "Landed costs", shipping_cost: "Shipping cost", fulfilment_cost: "Fulfilment", payment_fees: "Payment processing",
  selling_fees: "Other selling fees", return_handling: "Return handling", variable_costs: "Variable costs per order",
  contribution: "Contribution before advertising",
};

const describe = (codes: string[]) => codes.filter(isReason).map((code) => ({ code, text: REASONS[code].text }));

export function toBriefEconomics(rec: ProductRecommendation, meta: { runId: string; policyVersion: number; computedAt: string }): BriefEconomics {
  const e = rec.economics;
  const keys: LineKey[] = [...REVENUE_LINES, ...COST_LINES, "variable_costs", "contribution"];
  return {
    version: BRIEF_ECONOMICS_VERSION, status: "computed", run_id: meta.runId, product_id: rec.product_id, calc_version: rec.calc_version,
    policy_version: meta.policyVersion, computed_at: meta.computedAt, currency: e.currency ?? undefined, verdict: rec.verdict,
    reasons: describe(rec.reasons).slice(0, 20), notes: describe(rec.notes).slice(0, 30),
    confidence: { economics: rec.confidence.economics, acquisition: rec.confidence.acquisition, overall: rec.confidence.overall, why: rec.confidence.why.slice(0, 10) },
    unit: {
      net_revenue: e.net_revenue, variable_costs: e.variable_costs, contribution: e.contribution, contribution_margin: e.contribution_margin,
      break_even_cpa: e.break_even_cpa, maximum_viable_cpa: e.maximum_viable_cpa, target_cpa: e.target_cpa, break_even_roas: e.break_even_roas,
      target_roas: e.target_roas, platform_target_roas: e.platform_target_roas, contribution_upper_bound: e.contribution_upper_bound,
    },
    lines: keys.map((key) => ({ key, label: LABELS[key], amount: e.lines[key]?.amount ?? null, source: e.lines[key]?.provenance ?? "missing" })),
    budget: {
      status: rec.budget.status, kind: rec.budget.kind, test_budget: rec.budget.test_budget, daily_budget: rec.budget.daily_budget,
      test_days: rec.budget.test_days, max_experimental_loss: rec.budget.max_experimental_loss, binding: rec.budget.binding,
      ceilings: rec.budget.ceilings, sales_at_target_cpa: rec.budget.sales_at_target_cpa,
    },
  };
}

export const unavailableEconomics = (reason: UnavailableReason): BriefEconomics => ({ version: BRIEF_ECONOMICS_VERSION, status: "unavailable", unavailable_reason: reason });
