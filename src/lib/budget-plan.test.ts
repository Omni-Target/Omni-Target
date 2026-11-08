import { describe, expect, it } from "vitest";
import {
  BUDGET_PLAN_VERSION,
  computeBudgetPlan,
  describeBudgetPlan,
  normalizeMaxTotalBudget,
  normalizeTestDuration,
  readBudgetPlan,
  savedMaxTestBudget,
  withdrawnEngineBudget,
} from "./budget-plan";
import { formatCurrency } from "./currency";

describe("normalizeMaxTotalBudget", () => {
  it.each([
    [280, 280],
    [280.555, 280.56],
    ["280", 280],
    ["₦280,000", 280000],
    ["$1,250.50", 1250.5],
    ["USD 280", 280],
    ["280 EUR", 280],
    [" 1 000 ", 1000],
  ])("accepts %j as %j", (input, expected) => {
    expect(normalizeMaxTotalBudget(input)).toBe(expected);
  });

  it.each([
    null, undefined, "", 0, -50, "-50", "0", "0.001", 0.004, "1e5", "abc", "12.5.3", "10-20",
    Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_001, true, {}, [],
  ])("rejects %j instead of coercing it", (input) => {
    expect(normalizeMaxTotalBudget(input)).toBeNull();
  });
});

describe("normalizeTestDuration", () => {
  it("keeps the supported test lengths and defaults anything else to 14 days", () => {
    expect(normalizeTestDuration(7)).toBe(7);
    expect(normalizeTestDuration("30")).toBe(30);
    expect(normalizeTestDuration(10)).toBe(14);
    expect(normalizeTestDuration(undefined)).toBe(14);
  });
});

describe("computeBudgetPlan", () => {
  it("splits the merchant's cap evenly across the test", () => {
    expect(computeBudgetPlan({ currency: "USD", maxTotalBudget: 280, durationDays: 7 })).toEqual({
      version: BUDGET_PLAN_VERSION,
      basis: "merchant_cap",
      reason: "insufficient_product_evidence",
      currency: "USD",
      currency_symbol: null,
      max_total_budget: 280,
      duration_days: 7,
      daily_cap: 40,
    });
  });

  it("rounds the daily cap down so daily × days never exceeds the cap", () => {
    const usd = computeBudgetPlan({ currency: "USD", maxTotalBudget: 100, durationDays: 7 });
    expect(usd.daily_cap).toBe(14.28);
    expect(usd.daily_cap! * 7).toBeLessThanOrEqual(100);

    // Zero-decimal currencies floor to whole units.
    const ngn = computeBudgetPlan({ currency: "NGN", maxTotalBudget: 100000, durationDays: 30 });
    expect(ngn.daily_cap).toBe(3333);
    expect(ngn.daily_cap! * 30).toBeLessThanOrEqual(100000);
  });

  it("splits exactly when the cap divides evenly (no float drift)", () => {
    // 2.03 / 7 = 0.29 exactly; float math gives 0.28999…, which would floor to 0.28.
    expect(computeBudgetPlan({ currency: "USD", maxTotalBudget: 2.03, durationDays: 7 }).daily_cap).toBe(0.29);
    expect(computeBudgetPlan({ currency: "NGN", maxTotalBudget: 280000, durationDays: 14 }).daily_cap).toBe(20000);
  });

  it("produces no amounts when the merchant has not set a cap", () => {
    const plan = computeBudgetPlan({ currency: "USD", maxTotalBudget: null, durationDays: 14 });
    expect(plan.basis).toBe("not_set");
    expect(plan.max_total_budget).toBeNull();
    expect(plan.daily_cap).toBeNull();
  });

  it("does not trust malformed currency codes or symbols", () => {
    const plan = computeBudgetPlan({
      currency: "usd<script>",
      currencySymbol: "<img src=x>",
      maxTotalBudget: 70,
      durationDays: 7,
    });
    expect(plan.currency).toBe("USD");
    expect(plan.currency_symbol).toBeNull();
  });
});

describe("readBudgetPlan", () => {
  it("recomputes the daily cap from stored inputs instead of trusting stored amounts", () => {
    const tampered = {
      currency: "USD",
      max_total_budget: 280,
      duration_days: 7,
      daily_cap: 999_999, // not consistent with the cap — must be ignored
      basis: "merchant_cap",
    };
    const plan = readBudgetPlan(tampered);
    expect(plan.daily_cap).toBe(40);
  });

  it("falls back to the store currency for briefs saved before a plan existed", () => {
    const plan = readBudgetPlan(undefined, "NGN", "₦");
    expect(plan).toMatchObject({ basis: "not_set", currency: "NGN", currency_symbol: "₦", duration_days: 14 });
  });
});

describe("savedMaxTestBudget", () => {
  it("reads the saved plan first, then a pending merchant entry", () => {
    expect(savedMaxTestBudget({ budget_plan: { max_total_budget: 500 } })).toBe(500);
    expect(savedMaxTestBudget({ maxTestBudget: "750" })).toBe(750);
    expect(savedMaxTestBudget({})).toBeNull();
    expect(savedMaxTestBudget(null)).toBeNull();
    expect(savedMaxTestBudget({ budget_plan: { max_total_budget: -1 } })).toBeNull();
  });
});

describe("describeBudgetPlan", () => {
  it("says no recommendation is made when the cap is not set", () => {
    const text = describeBudgetPlan(computeBudgetPlan({ currency: "USD", durationDays: 14 }));
    expect(text.heading).toBe("No budget recommendation yet");
    expect(text.daily).toBe("Not set");
    expect(text.total).toBe("Not set");
    expect(text.duration).toBe("14-day test");
    expect(text.explanation).toContain("does not recommend an ad budget");
  });

  it("presents the cap as the merchant's limit, not a forecast", () => {
    const text = describeBudgetPlan(
      computeBudgetPlan({ currency: "NGN", currencySymbol: "₦", maxTotalBudget: 280000, durationDays: 14 }),
    );
    expect(text.heading).toBe("Your maximum test budget");
    expect(text.daily).toBe(`Up to ${formatCurrency(20000, "NGN", "₦")}/day`);
    expect(text.total).toBe(`${formatCurrency(280000, "NGN", "₦")} maximum over 14 days`);
    expect(text.explanation).toContain("not a performance forecast");
  });
});

describe("withdrawnEngineBudget", () => {
  it("carries no amounts, tiers or revenue reasoning", () => {
    const budget = withdrawnEngineBudget({
      currency: "USD",
      optimizationEvent: { event: "Purchase", reasoning: "Purchase is tracked." },
    });
    expect(budget.status).toBe("withdrawn");
    expect(budget.strategies).toEqual([]);
    for (const key of ["recommended_daily", "breakdown", "tier", "calculation", "recommended_total"]) {
      expect(budget).not.toHaveProperty(key);
    }
    expect(budget.reasoning).not.toMatch(/revenue|%/i);
  });
});
