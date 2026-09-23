import { describe, expect, it } from "vitest";
import { availableCredits } from "./credit-balance";

describe("availableCredits", () => {
  it("uses legacy credits when that is the balance shown by the gate", () => {
    expect(availableCredits({ credits: 30, credits_balance: 0 }, true)).toBe(30);
  });

  it("uses credits_balance when the legacy column is absent", () => {
    expect(availableCredits({ credits_balance: 4 }, false)).toBe(4);
  });

  it("falls back to credits_balance when legacy credits is null", () => {
    expect(availableCredits({ credits: null, credits_balance: 3 }, true)).toBe(3);
  });
});
