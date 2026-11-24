import { describe, expect, it } from "vitest";
import { normalQuantile, poissonBounds, regularisedGammaP, wilsonBounds } from "./stats";

describe("economics statistics (Phase 4)", () => {
  it("normal quantiles match published values", () => {
    expect(normalQuantile(0.9)).toBeCloseTo(1.281552, 5);
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 5);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 5);
  });

  it("Wilson bounds match a hand calculation and stay inside [0, 1]", () => {
    // 5 of 100 at 90%: z² = 1.642375; centre 0.05 + z²/200 = 0.058212; margin z × sqrt(0.000475 + z²/40000) = 0.029113;
    // denominator 1 + z²/100 = 1.016424 → upper 0.087325 / 1.016424, lower 0.029099 / 1.016424.
    const { lower, upper } = wilsonBounds(5, 100, 0.9);
    expect(upper).toBeCloseTo(0.085914, 5);
    expect(lower).toBeCloseTo(0.028629, 5);
    expect(wilsonBounds(0, 20, 0.9).lower).toBe(0);
    expect(wilsonBounds(0, 20, 0.9).upper).toBeCloseTo(0.0759, 3);
    expect(wilsonBounds(20, 20, 0.9).upper).toBe(1);
    expect(wilsonBounds(0, 0, 0.9)).toEqual({ lower: 0, upper: 1 });
  });

  it("regularised gamma and exact Poisson bounds match published tables", () => {
    expect(regularisedGammaP(1, 1)).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(regularisedGammaP(5, 3)).toBeCloseTo(0.184737, 5);
    // Zero events: upper bound −ln(α), 2.302585 at 90%.
    expect(poissonBounds(0, 0.9)).toEqual({ lower: 0, upper: expect.closeTo(2.302585, 5) });
    // 10 events at 90% one-sided: χ²(0.10; 20)/2 = 6.2213, χ²(0.90; 22)/2 = 15.4066.
    const ten = poissonBounds(10, 0.9);
    expect(ten.lower).toBeCloseTo(6.2213, 3);
    expect(ten.upper).toBeCloseTo(15.4066, 3);
    // 20 events at 95%: χ²(0.05; 40)/2 = 13.2547, χ²(0.95; 42)/2 = 29.0620.
    const twenty = poissonBounds(20, 0.95);
    expect(twenty.lower).toBeCloseTo(13.2547, 3);
    expect(twenty.upper).toBeCloseTo(29.062, 3);
    expect(() => poissonBounds(1.5, 0.9)).toThrow();
  });
});
