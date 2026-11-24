import { describe, expect, it } from "vitest";
import {
  legacyEngineBudget, legacyPdfTargetSpendPerSale, legacyPriceLessUnitCost, legacySurfaceFigures,
} from "./production-budget";
import { interimBudgetPlan } from "./interim-budget";

/**
 * Phase 4, task 1: the frozen copies reproduce the outputs documented in
 * architecture/phase-4-economics.md ("Task 1: how budgets are produced today").
 */
const store = { exchangeRate: 1, orderCount: 500 };

describe("production engine as at main@ad56bfc", () => {
  it("gives a $78,035/month store $142.86/day for any product priced under $285.71", () => {
    for (const productPrice of [20, 50, 120, 285]) {
      const r = legacyEngineBudget({ ...store, revenueLast30Days: 78_035, productPrice });
      expect(r).toMatchObject({ tier: "Scale", totalTestBudgetUSD: 2000, selectedRule: "revenue_tier_baseline", recommendedDaily: 143 });
      expect(r.finalDailyUSD).toBeCloseTo(142.857, 3);
    }
  });

  it("is not monotonic in revenue: $10,000 → $57.14/day, $10,001 → $50.01/day", () => {
    const at10k = legacyEngineBudget({ ...store, revenueLast30Days: 10_000, productPrice: 20 });
    const above = legacyEngineBudget({ ...store, revenueLast30Days: 10_001, productPrice: 20 });
    expect(at10k).toMatchObject({ tier: "Growth", totalTestBudgetUSD: 800, recommendedDaily: 57 });
    expect(above).toMatchObject({ tier: "Scale", recommendedDaily: 50 });
    expect(at10k.finalDailyUSD).toBeCloseTo(57.143, 3);
    expect(above.finalDailyUSD).toBeCloseTo(50.005, 3);
  });

  it("is not monotonic in price: $856 → $428/day, $860 → $142.86/day with a premium warning", () => {
    const at856 = legacyEngineBudget({ ...store, revenueLast30Days: 78_035, productPrice: 856 });
    const at860 = legacyEngineBudget({ ...store, revenueLast30Days: 78_035, productPrice: 860 });
    expect(at856).toMatchObject({ recommendedDaily: 428, selectedRule: "price_guardrail", premiumPriceWarning: false, highBudgetWarning: true });
    expect(at860).toMatchObject({ recommendedDaily: 143, selectedRule: "revenue_tier_baseline", premiumPriceWarning: true, highBudgetWarning: false });
  });

  it("warns 'at least' on any daily figure above $50, whatever the price, and strips warnings below 20 orders", () => {
    expect(legacyEngineBudget({ ...store, revenueLast30Days: 78_035, productPrice: 10 }).highBudgetWarning).toBe(true);
    const few = legacyEngineBudget({ exchangeRate: 1, orderCount: 12, revenueLast30Days: 78_035, productPrice: 10 });
    expect(few).toMatchObject({ recommendedDaily: 143, warningsShown: false });
  });

  it("gives stores with fewer than 20 orders a fixed 15 USD/day when no product is selected", () => {
    expect(legacyEngineBudget({ exchangeRate: 1, orderCount: 5, revenueLast30Days: 0 })).toMatchObject({
      path: "low_data_starter", recommendedDaily: 15, internationalRecommendedDaily: 18,
      strategies: [{ daily: 11 }, { daily: 15 }, { daily: 21 }],
    });
  });

  it("works in USD and converts back: ₦30m/month at ₦1,500/$ gives ₦150,000/day for a ₦45,000 product", () => {
    const r = legacyEngineBudget({ exchangeRate: 1500, orderCount: 400, revenueLast30Days: 30_000_000, productPrice: 45_000 });
    expect(r).toMatchObject({ tier: "Scale", recommendedDaily: 150_000 });
    expect(r.totalTestBudgetUSD).toBeCloseTo(1400, 6); // the old engine works in floating point
  });

  it("shows different daily figures on different surfaces, and adds overseas spend to the plain-text total", () => {
    const engine = legacyEngineBudget({ ...store, revenueLast30Days: 78_035, productPrice: 50 });
    const brand = legacySurfaceFigures(engine, { goal: "Grow Brand Awareness", exchangeRate: 1 });
    expect(brand).toEqual({
      briefAndPdfDaily: 86, plannerDaily: 86, targetingCardDaily: 143,
      plainText: { daily: 86, totalTestSpend: 1204, overseasDaily: 25, combinedDaily: 111, combinedTestSpend: 1554 },
      pdfScaleDaily: 103,
    });
  });

  it("reads 'price less unit cost' from the first variant's price and a plain average of costed variants", () => {
    expect(legacyPriceLessUnitCost([{ price: 80, unitCost: 30 }, { price: 120, unitCost: 50 }, { price: 100, unitCost: null }])).toBe(40);
    expect(legacyPriceLessUnitCost([{ price: 80, unitCost: null }])).toBeNull();
    expect(legacyPdfTargetSpendPerSale(80, 40)).toMatchObject({ amount: 40, label: "keeps each order profitable" });
    expect(legacyPdfTargetSpendPerSale(80, null)).toMatchObject({ amount: 28, basis: "35_percent_of_price" });
  });
});

describe("staging interim (S0.6) as at de99514", () => {
  it("splits the merchant's own maximum evenly, rounded down, with no recommendation", () => {
    expect(interimBudgetPlan({ maxTotalBudget: 500, durationDays: 14 })).toMatchObject({ basis: "merchant_cap", dailyCap: 35.71 });
    expect(interimBudgetPlan({ maxTotalBudget: 280_000, durationDays: 14, zeroDecimalCurrency: true })).toMatchObject({ dailyCap: 20_000 });
    expect(interimBudgetPlan({ maxTotalBudget: null })).toMatchObject({ basis: "not_set", dailyCap: null });
    expect(interimBudgetPlan({ maxTotalBudget: 500, priceLessUnitCost: -5 }).costCeilingPerSale).toBeNull();
  });
});
