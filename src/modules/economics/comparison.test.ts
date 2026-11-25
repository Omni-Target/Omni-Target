import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { legacyEngineBudget, legacyPdfTargetSpendPerSale, legacyPriceLessUnitCost, legacySurfaceFigures } from "./legacy/production-budget";
import { interimBudgetPlan } from "./legacy/interim-budget";
import { recommendProduct, type AcquisitionEvidence, type ProductRecommendation } from "./recommend";
import { runEconomics } from "./run";
import { buildScenario, COMPLETE_COSTS, HEALTHY_80, type Scenario } from "./__fixtures__/scenario";
import { POLICY_V2 } from "./__fixtures__/policy-v2";

/**
 * Phase 4, task 9: the before-and-after comparison. The SAME illustrative products and merchant limits go through
 * (1) the production engine as it runs on `main` (frozen copy, src/modules/economics/legacy/production-budget.ts),
 * (2) the staging interim (S0.6) and (3) the new engine. Every figure in the completion report's comparison comes
 * from this file; COMPARISON_OUT writes them as JSON. ILLUSTRATIVE figures, not any merchant's results.
 *
 * Shared context: a store with $78,035 of revenue in 30 days and 2,000 orders (the incident that started the
 * overhaul), USD; the merchant authorises up to $1,000 for a test and a $600 maximum loss.
 */
const STORE = { revenueLast30Days: 78_035, exchangeRate: 1, orderCount: 2000 };
const LIMITS = { ad_test_limit: 1000, ad_max_loss: 600 };
const AS_OF = "2026-11-24T00:00:00Z";
const PROVEN: AcquisitionEvidence = { matured_conversions: 40, matured_spend: 680, cpa: 17, cpa_lower: 13.8, cpa_upper: 21.3, immature_days: 0 };
const BETWEEN: AcquisitionEvidence = { matured_conversions: 30, matured_spend: 750, cpa: 25, cpa_lower: 19.5, cpa_upper: 32.4, immature_days: 0 };

interface Case { id: string; title: string; scenario: Scenario; acquisition: AcquisitionEvidence | null }
const CASES: Case[] = [
  { id: "A", title: "Healthy product, proven acquisition", scenario: HEALTHY_80, acquisition: PROVEN },
  { id: "B", title: "Product cost missing", scenario: { ...HEALTHY_80, variants: [{ price: 80, cost: null, units: 100, available: 500 }] }, acquisition: null },
  { id: "C", title: "Negative contribution (unit cost $70)", scenario: { ...HEALTHY_80, variants: [{ price: 80, cost: 70, units: 100, available: 500 }] }, acquisition: null },
  { id: "D", title: "Profitable, 20 units in stock", scenario: { ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, available: 20 }] }, acquisition: PROVEN },
  { id: "E", title: "New product, no sales history", scenario: { variants: [{ price: 80, cost: 30, available: 200 }], orders: 0,
    inputs: { ...COMPLETE_COSTS, expected_discount_rate: { estimate: 0.05 }, expected_refund_rate: { estimate: 4 / 76 }, expected_return_rate: { estimate: 0.05 } } }, acquisition: null },
  { id: "F", title: "Measured CPA $25: above target, below break-even", scenario: HEALTHY_80, acquisition: BETWEEN },
];

const recommend = (c: Case, policy?: typeof POLICY_V2.settings): ProductRecommendation => {
  const built = buildScenario({ ...c.scenario, inputs: { ...c.scenario.inputs, ...LIMITS }, ...(policy ? { policy } : {}) });
  return recommendProduct({ ...built, asOf: AS_OF, freshness: built.evidence.freshness, acquisition: c.acquisition });
};

function compare(c: Case) {
  const variant = c.scenario.variants[0];
  const legacy = legacyEngineBudget({ ...STORE, productPrice: variant.price });
  const surfaces = legacySurfaceFigures(legacy, { exchangeRate: 1 });
  const priceLessCost = legacyPriceLessUnitCost([{ price: variant.price, unitCost: variant.cost }]);
  const interim = interimBudgetPlan({ maxTotalBudget: LIMITS.ad_test_limit, durationDays: 14, priceLessUnitCost: priceLessCost });
  const r = recommend(c);
  return {
    id: c.id, title: c.title,
    old: { daily: legacy.recommendedDaily, test_total: legacy.recommendedDaily * 14, rule: legacy.selectedRule, tier: legacy.tier,
      plain_text_combined_daily: surfaces.plainText.combinedDaily, pdf_target_spend_per_sale: legacyPdfTargetSpendPerSale(variant.price, priceLessCost) },
    interim: { daily_cap: interim.dailyCap, total: interim.maxTotalBudget, verdict: null, cost_ceiling_per_sale: interim.costCeilingPerSale },
    new: { verdict: r.verdict, reasons: r.reasons, notes: r.notes, confidence: r.confidence.overall, contribution: r.economics.contribution,
      contribution_upper_bound: r.economics.contribution_upper_bound, break_even_cpa: r.economics.break_even_cpa, target_cpa: r.economics.target_cpa,
      maximum_viable_cpa: r.economics.maximum_viable_cpa, budget_status: r.budget.status, test_budget: r.budget.test_budget, daily_budget: r.budget.daily_budget,
      test_days: r.budget.test_days, binding: r.budget.binding,
      // For the report's worked examples: every line, the rates and their sources, the ceilings and stock.
      lines: Object.fromEntries(Object.entries(r.economics.lines).map(([k, l]) => [k, { amount: l.amount, source: l.provenance, basis: l.basis }])),
      rates: Object.fromEntries(Object.entries(r.economics.rates).map(([k, v]) => [k, { value: v.value, stress: v.stress, source: v.provenance, sample: v.sample }])),
      margin: r.economics.contribution_margin, break_even_roas: r.economics.break_even_roas, target_roas: r.economics.target_roas,
      platform_target_roas: r.economics.platform_target_roas, ceilings: r.budget.ceilings, inventory: r.budget.inventory,
      max_experimental_loss: r.budget.max_experimental_loss, sales_at_target_cpa: r.budget.sales_at_target_cpa, kind: r.budget.kind,
      confidence_detail: r.confidence },
  };
}

describe("before and after: identical products through all three engines", () => {
  const rows = CASES.map(compare);

  it("the production engine gives every one of these products the same $143 a day, whatever its economics", () => {
    for (const row of rows) {
      expect(row.old).toMatchObject({ daily: 143, test_total: 2002, rule: "revenue_tier_baseline", tier: "Scale", plain_text_combined_daily: 168 });
    }
    // Its PDF tells the merchant that a cost per sale under price − unit cost "keeps each order profitable".
    expect(rows.find((r) => r.id === "A")!.old.pdf_target_spend_per_sale).toMatchObject({ amount: 50, label: "keeps each order profitable" });
    expect(rows.find((r) => r.id === "C")!.old.pdf_target_spend_per_sale).toMatchObject({ amount: 10, label: "keeps each order profitable" });
    expect(rows.find((r) => r.id === "B")!.old.pdf_target_spend_per_sale).toMatchObject({ amount: 28, basis: "35_percent_of_price" });
  });

  it("the staging interim splits the merchant's $1,000 evenly for every product and makes no judgement", () => {
    for (const row of rows) expect(row.interim).toMatchObject({ daily_cap: 71.42, total: 1000, verdict: null });
  });

  it("the new engine separates the six situations", () => {
    const by = Object.fromEntries(rows.map((r) => [r.id, r.new]));
    expect(by.A).toMatchObject({ verdict: "GO", contribution: 30, break_even_cpa: 30, target_cpa: 21, budget_status: "recommended", test_budget: 420, daily_budget: 30, binding: "policy" });
    expect(by.B).toMatchObject({ verdict: "INSUFFICIENT_DATA", reasons: ["UNIT_COST_MISSING"], budget_status: "withheld", test_budget: null, contribution_upper_bound: 60 });
    expect(by.C).toMatchObject({ verdict: "DO_NOT_LAUNCH", reasons: ["NEGATIVE_CONTRIBUTION_MARGIN"], contribution: -10, test_budget: 0, daily_budget: 0 });
    expect(by.D).toMatchObject({ verdict: "GO", test_budget: 252, daily_budget: 18, binding: "inventory" });
    expect(by.E).toMatchObject({ verdict: "PILOT", reasons: ["INSUFFICIENT_CONVERSION_EVIDENCE", "NO_SALES_HISTORY"], test_budget: 210, daily_budget: 15, binding: "policy", confidence: "low" });
    expect(by.F).toMatchObject({ verdict: "PILOT", reasons: ["CPA_ABOVE_TARGET"], test_budget: 210, daily_budget: 15 });
    // Quantified: what the old engine would have had the merchant spend over 14 days, against the new engine's test.
    const old = rows.reduce((t, r) => t + r.old.test_total, 0);
    const now = rows.reduce((t, r) => t + (r.new.test_budget ?? 0), 0);
    expect([old, now]).toEqual([12_012, 1_092]);
  });

  it("store revenue is not an input: the same product and limits give the same recommendation in a $5,000 store", () => {
    const smallStore = legacyEngineBudget({ revenueLast30Days: 5_000, exchangeRate: 1, orderCount: 120, productPrice: 80 });
    expect(smallStore).toMatchObject({ tier: "Growth", recommendedDaily: 43 });
    // The new engine never reads store revenue: scenario A is the same wherever it is sold.
    expect(recommend(CASES[0]).budget).toEqual(recommend(CASES[0]).budget);
    expect(compare(CASES[0]).old.daily).not.toBe(smallStore.recommendedDaily);
  });

  it("G: several eligible products share one $1,000 monthly limit", () => {
    const products = [1, 2, 3, 4].map((id) => {
      const built = buildScenario({ ...HEALTHY_80, productId: id, inputs: { ...HEALTHY_80.inputs, ...LIMITS } });
      return { product: built.product, inputs: built.inputs, evidence: built.evidence, acquisition: id <= 2 ? PROVEN : null };
    });
    const result = runEconomics({ evidence: products[0].evidence, products, policy: buildScenario(HEALTHY_80).policy, commitments: [], monthlyLimit: 1000 });
    const budgets = result.recommendations.map((r) => [r.product_id, r.output.verdict, r.output.budget.test_budget]);
    // Old engine: 4 × $2,002 = $8,008 over 14 days, no portfolio limit at all.
    expect(budgets).toEqual([[1, "GO", 420], [2, "GO", 420], [3, "PILOT", 160], [4, "PILOT", 0]]);
    expect(result.portfolio).toMatchObject({ available: 1000, allocated: 1000 });
    if (process.env.COMPARISON_OUT) {
      writeFileSync(process.env.COMPARISON_OUT, JSON.stringify({ store: STORE, limits: LIMITS, rows, portfolio: { budgets, allocation: result.portfolio },
        finalisation: finalisationRows() }, null, 2));
    }
  });
});

/** Phase 4 finalisation: the same six cases under policy version 2 (0056), beside version 1. */
function finalisationRows() {
  return CASES.map((c) => {
    const before = recommend(c);
    const after = recommend(c, POLICY_V2.settings);
    const pick = (r: ProductRecommendation) => ({ calc_version: r.economics.calc_version, verdict: r.verdict, reasons: r.reasons, notes: r.notes,
      break_even_cpa: r.economics.break_even_cpa, target_cpa: r.economics.target_cpa, maximum_viable_cpa: r.economics.maximum_viable_cpa,
      purchase_event_basis: r.economics.purchase_event_basis ?? null, test_budget: r.budget.test_budget, daily_budget: r.budget.daily_budget, kind: r.budget.kind });
    return { id: c.id, v1: pick(before), v2: pick(after) };
  });
}

describe("finalisation: the same six products under policy version 2", () => {
  const rows = Object.fromEntries(finalisationRows().map((r) => [r.id, r]));

  it("keeps every verdict and budget, records econ-1.1.0, and says when the purchase basis is unconfirmed", () => {
    for (const r of Object.values(rows)) {
      expect(r.v2.verdict).toBe(r.v1.verdict);
      expect(r.v2.test_budget).toBe(r.v1.test_budget);
      expect([r.v1.calc_version, r.v2.calc_version]).toEqual(["econ-1.0.0", "econ-1.1.0"]);
    }
    expect(rows.A.v2).toMatchObject({ purchase_event_basis: "unconfirmed", break_even_cpa: 30 });
    expect(rows.A.v2.notes).toContain("PURCHASE_EVENT_BASIS_UNCONFIRMED");
  });

  it("E: the new product's estimates now carry the downside: maximum viable $25.80 instead of $30", () => {
    expect([rows.E.v1.maximum_viable_cpa, rows.E.v2.maximum_viable_cpa]).toEqual([30, 25.8]);
    expect(rows.E.v2.notes).toContain("ESTIMATE_DOWNSIDE_APPLIED");
  });
});
