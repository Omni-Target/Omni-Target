import { describe, expect, it } from "vitest";
import { runEconomics, recompute, type ProductRunInput } from "./run";
import type { AcquisitionEvidence } from "./recommend";
import { buildScenario, COMPLETE_COSTS, HEALTHY_80, type Scenario } from "./__fixtures__/scenario";

/**
 * Phase 4, task 6: the portfolio never exceeds the merchant's limit, and every recommendation recomputes from
 * what was recorded. ILLUSTRATIVE products; the expected allocation is worked out in the comments.
 */
const AUTHORITY = { ad_test_limit: 1000, ad_max_loss: 600 };
const proven = (conversions: number, spend: number, lower: number, upper: number): AcquisitionEvidence =>
  ({ matured_conversions: conversions, matured_spend: spend, cpa: Math.round((spend / conversions) * 100) / 100, cpa_lower: lower, cpa_upper: upper, immature_days: 0 });
function product(id: number, s: Scenario, acquisition: AcquisitionEvidence | null = null): ProductRunInput & { evidence: ReturnType<typeof buildScenario>["evidence"] } {
  const built = buildScenario({ ...s, productId: id, inputs: { ...AUTHORITY, ...s.inputs } });
  return { product: built.product, inputs: built.inputs, acquisition, evidence: built.evidence };
}
const policy = buildScenario(HEALTHY_80).policy;

describe("scenario G: several eligible products, one merchant limit", () => {
  const products = [
    product(1, HEALTHY_80, proven(40, 680, 13.8, 21.3)),   // GO, margin of safety (30 − 21.30) ÷ 30 = 0.29; test $420
    product(2, HEALTHY_80, proven(30, 570, 15.2, 25)),     // GO, margin (30 − 25) ÷ 30 = 0.17; test $420
    product(3, HEALTHY_80),                                // PILOT, target $21 ÷ net $72 = 0.29; test $210
    product(4, { ...HEALTHY_80, variants: [{ price: 60, cost: 24, units: 100, available: 500 }] }), // PILOT, lower headroom
    product(9, HEALTHY_80),                                // already in the active campaign below
    product(10, { ...HEALTHY_80, variants: [{ price: 80, cost: null, units: 100, available: 500 }] }), // INSUFFICIENT DATA
  ];
  // One campaign covers products 9 and 11 with $300 still to spend: counted once.
  const commitments = [{ campaign_id: "c-1", product_ids: [9, 11], amount: 300 }];
  const result = runEconomics({ evidence: products[0].evidence, products, policy, commitments, monthlyLimit: 1000 });
  const byId = Object.fromEntries(result.recommendations.map((r) => [r.product_id, r.output]));
  const allocation = Object.fromEntries(result.portfolio!.allocations.map((a) => [a.product_id, a]));

  it("allocates in a fixed, explained order and never beyond the $700 left after commitments", () => {
    expect(result.portfolio).toMatchObject({ monthly_limit: 1000, committed: 300, available: 700, allocated: 700 });
    expect(allocation[1]).toMatchObject({ rank: 1, requested: 420, allocated: 420, outcome: "full" });
    // $280 remains: enough for a meaningful test (5 × $21 = $105), so product 2 gets it.
    expect(allocation[2]).toMatchObject({ rank: 2, requested: 420, allocated: 280, outcome: "partial", reason: "PORTFOLIO_LIMIT_REACHED" });
    expect(allocation[3]).toMatchObject({ rank: 3, allocated: 0, outcome: "none", reason: "PORTFOLIO_LIMIT_REACHED" });
    expect(allocation[4]).toMatchObject({ rank: 4, allocated: 0, outcome: "none" });
    expect(allocation[9]).toMatchObject({ rank: null, outcome: "already_funded", reason: "ALREADY_IN_ACTIVE_CAMPAIGN" });
    expect(allocation[10]).toMatchObject({ rank: null, outcome: "not_a_candidate" });
    expect(allocation[1].rank_basis).toMatch(/proven \(GO\); measured cost per sale at most 21.3 against break-even 30/);
  });

  it("re-sizes each product's budget to its allocation", () => {
    expect(byId[1].budget).toMatchObject({ test_budget: 420, binding: "policy" });
    expect(byId[2].budget).toMatchObject({ test_budget: 280, daily_budget: 20, binding: "portfolio" });
    expect(byId[3].budget).toMatchObject({ status: "zero", test_budget: 0, binding: "portfolio" });
    expect(byId[3].notes).toEqual(expect.arrayContaining(["PORTFOLIO_LIMIT_REACHED", "BUDGET_BELOW_MINIMUM_TEST"]));
    expect(byId[9].budget).toMatchObject({ status: "zero", test_budget: 0 });
    expect(byId[9].notes).toContain("ALREADY_IN_ACTIVE_CAMPAIGN");
    expect(byId[10].budget.status).toBe("withheld");
    const total = result.recommendations.reduce((t, r) => t + (r.output.budget.test_budget ?? 0), 0);
    expect(total).toBeLessThanOrEqual(700);
  });

  it("without a monthly limit, each product keeps its own test budget", () => {
    const free = runEconomics({ evidence: products[0].evidence, products, policy, commitments: [], monthlyLimit: null });
    expect(free.portfolio).toBeNull();
    expect(free.recommendations.find((r) => r.product_id === 3)!.output.budget.test_budget).toBe(210);
  });

  it("every recommendation recomputes identically from what is recorded", () => {
    for (const recorded of result.recommendations) {
      const stored = JSON.parse(JSON.stringify(recorded));
      expect(recompute(stored)).toEqual(stored.output);
    }
  });
});

function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, pick: (lo: number, hi: number) => Math.round((lo + next() * (hi - lo)) * 100) / 100, int: (lo: number, hi: number) => Math.floor(lo + next() * (hi - lo + 1)) };
}

describe("properties over 300 random portfolios", () => {
  it("the total never exceeds the limit less commitments, funded products get nothing new, and everything recomputes", () => {
    const g = generator(77);
    for (let run = 0; run < 300; run += 1) {
      const count = g.int(2, 8);
      const products = Array.from({ length: count }, (_, i) => {
        const orders = g.int(0, 200);
        const s: Scenario = { variants: [{ price: g.pick(20, 200), cost: g.pick(5, 80), units: orders, available: g.int(0, 600) }], orders,
          discountRate: g.pick(0, 0.1), refundRate: g.pick(0, 0.1), refundedOrders: g.int(0, Math.floor(orders / 10)),
          inputs: { ...COMPLETE_COSTS, expected_discount_rate: { estimate: 0.05 }, expected_refund_rate: { estimate: 0.05 }, expected_return_rate: { estimate: 0.05 },
            ad_test_limit: g.pick(100, 1500), ...(g.next() < 0.5 ? { ad_daily_limit: g.pick(5, 100) } : {}) } };
        const conversions = g.int(0, 50);
        const spend = g.pick(100, 1500);
        return product(i + 1, s, conversions > 0 && g.next() < 0.5 ? proven(conversions, spend, spend / (conversions * 1.4), spend / (conversions * 0.75)) : null);
      });
      const commitments = g.next() < 0.5 ? [{ campaign_id: "c", product_ids: [g.int(1, count), 99], amount: g.pick(0, 800) }] : [];
      const monthlyLimit = g.pick(0, 3000);
      const result = runEconomics({ evidence: products[0].evidence, products, policy, commitments, monthlyLimit, testDays: [7, 14, 30][g.int(0, 2)] });
      const available = Math.max(0, Math.round(monthlyLimit * 100) - commitments.reduce((t, c) => t + Math.round(c.amount * 100), 0));
      const total = result.recommendations.reduce((t, r) => t + Math.round((r.output.budget.test_budget ?? 0) * 100), 0);
      expect(total).toBeLessThanOrEqual(available);
      expect(Math.round(result.portfolio!.allocated * 100)).toBeLessThanOrEqual(available);
      for (const r of result.recommendations) {
        if (commitments.some((c) => c.product_ids.includes(r.product_id))) expect(r.output.budget.test_budget ?? 0).toBe(0);
        expect(recompute(JSON.parse(JSON.stringify(r)))).toEqual(r.output);
      }
    }
  });
});
