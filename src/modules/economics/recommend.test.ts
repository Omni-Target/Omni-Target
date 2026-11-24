import { describe, expect, it } from "vitest";
import { recommendProduct, type AcquisitionEvidence, type RecommendArgs } from "./recommend";
import { buildScenario, COMPLETE_COSTS, HEALTHY_80, type Scenario } from "./__fixtures__/scenario";

/**
 * Phase 4, task 5: verdicts and budgets for the required scenarios A–F (architecture/phase-4-economics.md).
 * ILLUSTRATIVE inputs; each expected figure is worked out in the comment beside it.
 * Shared: the $80 product (break-even $30, target $21, one unit per order, 100 orders in the last 180 days, so
 * organic demand reserves ceil(100/180 × 14) = 8 units over a 14-day test). Merchant limits: $1,000 per test,
 * $600 maximum loss, $50 a day.
 */
const AUTHORITY = { ad_test_limit: 1000, ad_max_loss: 600, ad_daily_limit: 50 };
const rec = (s: Scenario, extra: Partial<RecommendArgs> = {}) => {
  const built = buildScenario({ ...s, inputs: { ...AUTHORITY, ...s.inputs } });
  return recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: built.evidence.freshness, ...extra });
};
const proven = (conversions: number, spend: number, lower: number, upper: number, immature = 0): AcquisitionEvidence =>
  ({ matured_conversions: conversions, matured_spend: spend, cpa: Math.round((spend / conversions) * 100) / 100, cpa_lower: lower, cpa_upper: upper, immature_days: immature });

describe("the required scenarios", () => {
  it("A: a healthy, proven product gets a controlled test sized by policy (GO)", () => {
    // 40 matured sales for $680: CPA $17 ≤ $21 target, upper bound $21.30 ≤ $30 break-even.
    const r = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, available: 500 }] }, { acquisition: proven(40, 680, 13.8, 21.3) });
    expect(r.verdict).toBe("GO");
    expect(r.confidence).toMatchObject({ economics: "high", acquisition: "proven", overall: "high" });
    // Ceilings: policy 20 × $21 = $420; merchant min($1,000, $600) = $600; inventory (500 − 8) × $21 = $10,332.
    expect(r.budget).toMatchObject({ status: "recommended", kind: "controlled_test", test_budget: 420, daily_budget: 30, test_days: 14,
      max_experimental_loss: 600, binding: "policy", sales_at_target_cpa: 20,
      ceilings: { policy: 420, merchant: 600, inventory: 10332, portfolio: null },
      inventory: { sellable_units: 500, organic_reserve_units: 8, units_for_ads: 492, max_orders: 492 } });
    expect(r.notes).toContain("POLICY_LIMIT_BINDING");
  });

  it("B: a missing product cost gives INSUFFICIENT DATA and no amounts", () => {
    const r = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: null, units: 100, available: 500 }] });
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.reasons).toEqual(["UNIT_COST_MISSING"]);
    expect(r.budget).toMatchObject({ status: "withheld", test_budget: null, daily_budget: null, ongoing_budget: null });
    expect(r.economics).toMatchObject({ break_even_cpa: null, target_cpa: null });
  });

  it("C: negative contribution gives DO NOT LAUNCH and exactly zero", () => {
    const r = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 70, units: 100, available: 500 }] });
    expect(r.verdict).toBe("DO_NOT_LAUNCH");
    expect(r.reasons).toEqual(["NEGATIVE_CONTRIBUTION_MARGIN"]);
    expect(r.economics.contribution).toBe(-10);
    expect(r.budget).toMatchObject({ status: "zero", test_budget: 0, daily_budget: 0, ongoing_budget: 0, max_experimental_loss: 0 });
  });

  it("D: profitable but inventory-limited: stock sets the ceiling", () => {
    // 20 units − 8 reserved for organic demand = 12 orders × $21 = $252, below the $420 policy and $600 merchant ceilings.
    const r = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, available: 20 }] }, { acquisition: proven(40, 680, 13.8, 21.3) });
    expect(r.verdict).toBe("GO");
    expect(r.budget).toMatchObject({ test_budget: 252, daily_budget: 18, binding: "inventory", inventory: { units_for_ads: 12, max_orders: 12 } });
    expect(r.notes).toContain("INVENTORY_LIMITED");
  });

  it("E: a new product without sales gets a small pilot within the merchant's own limit", () => {
    const r = rec({ variants: [{ price: 80, cost: 30, available: 200 }], orders: 0,
      inputs: { ...COMPLETE_COSTS, ad_test_limit: 150, ad_max_loss: 150, ad_daily_limit: undefined as unknown as number,
        expected_discount_rate: { estimate: 0.05 }, expected_refund_rate: { estimate: 4 / 76 }, expected_return_rate: { estimate: 0.05 } } });
    expect(r.verdict).toBe("PILOT");
    expect(r.reasons).toEqual(["INSUFFICIENT_CONVERSION_EVIDENCE", "NO_SALES_HISTORY"]);
    expect(r.confidence).toMatchObject({ economics: "low", acquisition: "unproven", overall: "low" });
    // Policy pilot 10 × $21 = $210; merchant $150 binds; $150 ÷ 14 days = $10.71 a day.
    expect(r.budget).toMatchObject({ kind: "pilot", test_budget: 150, daily_budget: 10.71, test_days: 14, binding: "merchant", max_experimental_loss: 150 });
    expect(r.notes).toEqual(expect.arrayContaining(["DISCOUNT_RATE_MERCHANT_ESTIMATE", "RETURN_RATE_MERCHANT_ESTIMATE", "MERCHANT_LIMIT_BINDING"]));
  });

  it("F: a measured CPA between target and break-even gives a limited pilot, not scaling", () => {
    // 30 matured sales for $750: CPA $25, above the $21 target, below the $30 break-even; the lower bound $19.50 is under break-even.
    const r = rec(HEALTHY_80, { acquisition: proven(30, 750, 19.5, 32.4, 3) });
    expect(r.verdict).toBe("PILOT");
    expect(r.reasons).toEqual(["CPA_ABOVE_TARGET"]);
    expect(r.notes).toContain("ATTRIBUTION_IMMATURE");
    expect(r.budget).toMatchObject({ kind: "pilot", test_budget: 210, binding: "policy" });
  });
});

describe("restrictions, unviable acquisition and the merchant's authority", () => {
  it("blocks with exactly zero for each hard restriction", () => {
    const cases: Array<[Scenario, Partial<RecommendArgs>, string]> = [
      [{ ...HEALTHY_80, status: "draft" }, {}, "PRODUCT_NOT_ACTIVE"],
      [{ ...HEALTHY_80, giftCard: true }, {}, "GIFT_CARD"],
      [{ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, available: 0 }] }, {}, "OUT_OF_STOCK"],
      [HEALTHY_80, { targetMarketServiced: false }, "TARGET_MARKET_NOT_SERVICED"],
      [{ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, advertising_excluded: 1 } }, {}, "MERCHANT_EXCLUDED"],
    ];
    for (const [s, extra, reason] of cases) {
      const r = rec(s, extra);
      expect([r.verdict, r.reasons, r.budget.test_budget, r.budget.daily_budget], reason).toEqual(["BLOCKED", [reason], 0, 0]);
    }
    // Overselling allowed with no stock is not blocked; only stock on hand would count.
    expect(rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, available: 0, policy: "continue" }] }).verdict).not.toBe("BLOCKED");
  });

  it("stops at break-even: a proven CPA whose lower bound exceeds it gives DO NOT LAUNCH", () => {
    const r = rec(HEALTHY_80, { acquisition: proven(25, 1000, 35.1, 52) });
    expect([r.verdict, r.reasons, r.budget.test_budget]).toEqual(["DO_NOT_LAUNCH", ["CPA_ABOVE_BREAK_EVEN"], 0]);
  });

  it("settles unviable economics even with an input missing, when what is known already loses money", () => {
    // $10 price: shipping $7 + fulfilment $2 + fees exceed revenue before any product cost.
    const r = rec({ ...HEALTHY_80, variants: [{ price: 10, cost: null, units: 100, available: 500 }] });
    expect(r.verdict).toBe("DO_NOT_LAUNCH");
    expect(r.economics.missing).toEqual(["UNIT_COST_MISSING"]);
    expect(r.economics.contribution_upper_bound).toBeLessThanOrEqual(0);
  });

  it("recommends no amount until the merchant authorises a limit, but shows the other ceilings", () => {
    const built = buildScenario(HEALTHY_80);
    const r = recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: built.evidence.freshness });
    expect(r.verdict).toBe("PILOT");
    expect(r.budget).toMatchObject({ status: "awaiting_authority", test_budget: null, ceilings: { merchant: null, policy: 210, inventory: 10332 } });
    expect(r.notes).toContain("MERCHANT_AUTHORITY_MISSING");
  });

  it("stretches the test when the daily limit binds, then spends less", () => {
    const go = { acquisition: proven(40, 680, 13.8, 21.3) };
    // $420 at $20 a day: 21 days.
    expect(rec({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ad_daily_limit: 20 } }, go).budget).toMatchObject({ test_budget: 420, daily_budget: 20, test_days: 21 });
    // $420 at $10 a day would take 42 days; the policy's longest test is 30: $300.
    expect(rec({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ad_daily_limit: 10 } }, go).budget).toMatchObject({ test_budget: 300, daily_budget: 10, test_days: 30 });
  });

  it("recommends nothing when the room left is too small to learn from, and respects the portfolio", () => {
    // 12 units − 8 reserved = 4 orders × $21 = $84, under the minimum test of 5 × $21 = $105.
    const small = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, available: 12 }] });
    expect(small.budget).toMatchObject({ status: "zero", test_budget: 0, binding: "inventory" });
    expect(small.notes).toEqual(expect.arrayContaining(["BUDGET_BELOW_MINIMUM_TEST", "INVENTORY_LIMITED"]));
    const portfolio = rec(HEALTHY_80, { portfolioLimit: 150 });
    expect(portfolio.budget).toMatchObject({ test_budget: 150, binding: "portfolio" });
    expect(portfolio.notes).toContain("PORTFOLIO_LIMIT_REACHED");
  });

  it("lowers confidence for stale stock and does not cap untracked stock", () => {
    const stale = rec(HEALTHY_80, { freshness: { inventory: "2026-11-19T00:00:00Z" } });
    expect(stale.notes).toContain("INVENTORY_STALE");
    expect(stale.confidence.economics).toBe("medium");
    const untracked = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, tracked: false }] });
    expect(untracked.budget.ceilings.inventory).toBeNull();
    expect(untracked.notes).toContain("INVENTORY_UNTRACKED");
    const unknown = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100 }] });
    expect(unknown.notes).toEqual(expect.arrayContaining(["INVENTORY_UNKNOWN", "BUDGET_BELOW_MINIMUM_TEST"]));
  });
});

/** Seeded generator: properties stay deterministic. */
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, pick: (lo: number, hi: number) => Math.round((lo + next() * (hi - lo)) * 100) / 100, int: (lo: number, hi: number) => Math.floor(lo + next() * (hi - lo + 1)) };
}

describe("properties over 1,000 random products", () => {
  const g = generator(424242);
  const cases = Array.from({ length: 1000 }, () => {
    const orders = g.int(0, 300);
    const s: Scenario = {
      variants: [{ price: g.pick(5, 300), cost: g.next() < 0.1 ? null : g.pick(1, 200), units: orders * g.int(1, 2), available: g.next() < 0.1 ? undefined : g.int(0, 400), tracked: g.next() > 0.05 }],
      orders, recentUnits: g.int(0, orders), discountRate: g.pick(0, 0.2), refundRate: g.pick(0, 0.2), refundedOrders: g.int(0, Math.floor(orders / 5)),
      status: g.next() < 0.05 ? "draft" : "active",
      inputs: { ...COMPLETE_COSTS, expected_discount_rate: { estimate: 0.05 }, expected_refund_rate: { estimate: 0.05 }, expected_return_rate: { estimate: 0.05 },
        ...(g.next() < 0.85 ? { ad_test_limit: g.pick(50, 2000) } : {}), ...(g.next() < 0.5 ? { ad_max_loss: g.pick(50, 2000) } : {}),
        ...(g.next() < 0.5 ? { ad_daily_limit: g.pick(5, 200) } : {}), shipping_cost_per_order: g.pick(0, 15) },
    };
    const conversions = g.int(0, 60);
    const spend = g.pick(50, 3000);
    const acquisition = g.next() < 0.5 && conversions > 0 ? proven(conversions, spend, spend / (conversions * 1.4), spend / (conversions * 0.7)) : null;
    const built = buildScenario(s);
    return { s, r: recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: built.evidence.freshness, acquisition,
      portfolioLimit: g.next() < 0.3 ? g.pick(0, 1500) : null, testDays: [7, 14, 30][g.int(0, 2)] }) };
  });

  it("zero for blocked and unviable, no amounts for missing data, and never above any ceiling", () => {
    for (const { s, r } of cases) {
      const b = r.budget;
      if (r.verdict === "BLOCKED" || r.verdict === "DO_NOT_LAUNCH") expect([b.test_budget, b.daily_budget]).toEqual([0, 0]);
      if (r.verdict === "INSUFFICIENT_DATA") expect([b.test_budget, b.daily_budget, b.status]).toEqual([null, null, "withheld"]);
      if (b.status !== "recommended") continue;
      const test = b.test_budget as number;
      for (const ceiling of Object.values(b.ceilings)) if (ceiling !== null) expect(test).toBeLessThanOrEqual(ceiling);
      expect(test).toBeLessThanOrEqual(s.inputs?.ad_test_limit as number ?? Infinity);
      if (typeof s.inputs?.ad_max_loss === "number") expect(test).toBeLessThanOrEqual(s.inputs.ad_max_loss);
      if (typeof s.inputs?.ad_daily_limit === "number") expect(b.daily_budget!).toBeLessThanOrEqual(s.inputs.ad_daily_limit);
      expect(Math.round(b.daily_budget! * b.test_days! * 100)).toBeLessThanOrEqual(Math.round(test * 100));
      expect(test).toBeGreaterThanOrEqual(5 * (r.economics.target_cpa as number) - 1e-9);
      expect(r.economics.target_cpa!).toBeLessThanOrEqual(r.economics.break_even_cpa!);
    }
  });

  it("GO only with proven acquisition at or under target, and never on low economics confidence", () => {
    for (const { r } of cases.filter((c) => c.r.verdict === "GO")) {
      expect(r.confidence.acquisition).toBe("proven");
      expect(r.confidence.economics).not.toBe("low");
      expect(r.budget.kind === null || r.budget.kind === "controlled_test").toBe(true);
    }
    expect(cases.some((c) => c.r.verdict === "GO")).toBe(true);
    expect(new Set(cases.map((c) => c.r.verdict))).toEqual(new Set(["GO", "PILOT", "DO_NOT_LAUNCH", "INSUFFICIENT_DATA", "BLOCKED"]));
  });
});
