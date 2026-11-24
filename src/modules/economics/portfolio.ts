/**
 * Portfolio allocation (Phase 4, task 6; architecture/phase-4-economics.md, "Portfolio allocation").
 *
 * Several products can each deserve a test; together they must stay inside the merchant's advertising limit
 * for the period. The allocator is a fixed, explainable order, not a score:
 *   1. what is available: the limit less the period's existing commitments (a campaign shared by several
 *      products is counted once);
 *   2. candidates: GO and PILOT products with a recommended test; a product already in an active campaign is
 *      not given a second budget;
 *   3. order: GO before PILOT; then margin of safety; then economics confidence; then product ID;
 *   4. each product receives its full test budget while it fits, else what remains if that is still a
 *      meaningful test (the policy's minimum sales at its target CPA), else nothing.
 * The sum of allocations never exceeds what is available.
 */
import { money } from "./money";
import type { EconomicsPolicySettings } from "./policy";
import type { ProductRecommendation } from "./recommend";
import type { ReasonCode } from "./reasons";

/** An existing campaign's spend still to come in the period, and the products it covers. */
export interface Commitment {
  campaign_id: string;
  product_ids: number[];
  /** Spend still expected in the period, in the shop's currency. */
  amount: number;
}

export interface Allocation {
  product_id: number;
  rank: number | null;
  /** Why this place in the order, in words. */
  rank_basis: string;
  requested: number;
  allocated: number;
  outcome: "full" | "partial" | "none" | "already_funded" | "not_a_candidate";
  reason: ReasonCode | null;
}

export interface PortfolioAllocation {
  currency: string;
  period_days: number;
  monthly_limit: number | null;
  committed: number;
  available: number | null;
  allocated: number;
  allocations: Allocation[];
}

const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** Margin of safety: how far below break-even the cost per sale is expected to stay. */
function marginOfSafety(r: ProductRecommendation, cpaUpper: number | null): { value: number; basis: string } {
  const be = r.economics.break_even_cpa ?? 0;
  if (cpaUpper !== null && be > 0) {
    return { value: (be - cpaUpper) / be, basis: `measured cost per sale at most ${cpaUpper} against break-even ${be}` };
  }
  const net = r.economics.net_revenue ?? 0;
  const target = r.economics.target_cpa ?? 0;
  return { value: net > 0 ? target / net : 0, basis: `target cost per sale ${target} on net revenue ${net} per order` };
}

export function allocatePortfolio(args: {
  currency: string;
  recommendations: ProductRecommendation[];
  /** Measured CPA upper bounds by product (task 7), where proven. */
  cpaUpper?: Map<number, number>;
  commitments: Commitment[];
  monthlyLimit: number | null;
  policy: EconomicsPolicySettings;
}): PortfolioAllocation {
  const m = money(args.currency);
  const funded = new Set(args.commitments.flatMap((c) => c.product_ids));
  // One amount per campaign, however many products share it.
  const byCampaign = new Map(args.commitments.map((c) => [c.campaign_id, Math.max(0, c.amount)]));
  const committed = [...byCampaign.values()].reduce((t, a) => t + m.up(a), 0);
  const limit = args.monthlyLimit === null ? null : m.down(args.monthlyLimit);
  let remaining = limit === null ? null : Math.max(0, limit - committed);

  const candidates = args.recommendations.filter((r) => (r.verdict === "GO" || r.verdict === "PILOT") && r.budget.status === "recommended"
    && (r.budget.test_budget ?? 0) > 0 && !funded.has(r.product_id));
  const ordered = candidates.map((r) => ({ r, safety: marginOfSafety(r, args.cpaUpper?.get(r.product_id) ?? null) }))
    .sort((a, b) => (a.r.verdict === "GO" ? 0 : 1) - (b.r.verdict === "GO" ? 0 : 1)
      || b.safety.value - a.safety.value
      || CONFIDENCE_ORDER[a.r.confidence.economics ?? "low"] - CONFIDENCE_ORDER[b.r.confidence.economics ?? "low"]
      || a.r.product_id - b.r.product_id);

  const allocations: Allocation[] = [];
  ordered.forEach(({ r, safety }, index) => {
    const requested = m.down(r.budget.test_budget as number);
    const minimum = m.down(r.economics.target_cpa as number) * args.policy.min_test_conversions;
    const basis = `${r.verdict === "GO" ? "proven (GO)" : "pilot"}; ${safety.basis}; economics confidence ${r.confidence.economics}`;
    let allocated: number;
    let outcome: Allocation["outcome"];
    if (remaining === null || requested <= remaining) { allocated = requested; outcome = "full"; }
    else if (remaining >= minimum) { allocated = remaining; outcome = "partial"; }
    else { allocated = 0; outcome = "none"; }
    if (remaining !== null) remaining -= allocated;
    allocations.push({ product_id: r.product_id, rank: index + 1, rank_basis: basis, requested: m.major(requested), allocated: m.major(allocated), outcome,
      reason: outcome === "full" ? null : "PORTFOLIO_LIMIT_REACHED" });
  });
  for (const r of args.recommendations) {
    if (candidates.includes(r)) continue;
    const fundedAlready = funded.has(r.product_id);
    allocations.push({ product_id: r.product_id, rank: null, rank_basis: fundedAlready ? "already in an active campaign" : `not a candidate: ${r.verdict}`,
      requested: 0, allocated: 0, outcome: fundedAlready ? "already_funded" : "not_a_candidate", reason: fundedAlready ? "ALREADY_IN_ACTIVE_CAMPAIGN" : null });
  }
  const total = allocations.reduce((t, a) => t + m.down(a.allocated), 0);
  return {
    currency: args.currency, period_days: args.policy.portfolio_period_days, monthly_limit: limit === null ? null : m.major(limit),
    committed: m.major(committed), available: limit === null ? null : m.major(Math.max(0, limit - committed)), allocated: m.major(total), allocations,
  };
}
