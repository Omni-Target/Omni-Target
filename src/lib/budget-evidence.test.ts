import { describe, expect, it } from "vitest";
import { estimateDailyTestBudget } from "./budget-evidence";

describe("estimateDailyTestBudget", () => {
  it("uses the revenue baseline for inexpensive products", () => {
    expect(estimateDailyTestBudget(100, 120)).toBe(100);
  });

  it("raises the estimate to half the product price when appropriate", () => {
    expect(estimateDailyTestBudget(100, 300)).toBe(150);
  });

  it("keeps the baseline when the price guardrail is over three times higher", () => {
    expect(estimateDailyTestBudget(100, 800)).toBe(100);
  });
});
