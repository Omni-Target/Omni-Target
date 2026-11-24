import { describe, expect, it } from "vitest";
import { minorUnitExponent, money } from "./money";

describe("money in minor units (Phase 4)", () => {
  it("knows each currency's minor unit", () => {
    expect([minorUnitExponent("USD"), minorUnitExponent("NGN"), minorUnitExponent("JPY"), minorUnitExponent("KWD"), minorUnitExponent("gbp")]).toEqual([2, 2, 0, 3, 2]);
  });

  it("rounds costs up and revenue, ceilings and budgets down, absorbing floating-point error only", () => {
    const usd = money("USD");
    expect(usd.up(2.001)).toBe(201);
    expect(usd.down(2.009)).toBe(200);
    expect(usd.up(76 * (4 / 76))).toBe(400); // 3.9999999999999996 is 4.00, not 4.01
    expect(usd.down(0.1 + 0.2)).toBe(30); // 0.30000000000000004 is 0.30
    expect(Object.is(usd.up(0), 0)).toBe(true); // never −0
    const jpy = money("JPY");
    expect([jpy.up(100.2), jpy.down(100.8), jpy.major(101)]).toEqual([101, 100, 101]);
    expect(money("KWD").major(1234)).toBe(1.234);
  });
});
