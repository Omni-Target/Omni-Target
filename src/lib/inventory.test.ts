import { describe, expect, it } from "vitest";
import { variantSellable } from "./inventory";

describe("variantSellable (Phase 3 task 3; ING-09)", () => {
  it("sells an untracked variant and a keep-selling variant without stock", () => {
    expect(variantSellable({ inventory_quantity: 0, inventory_management: null })).toBe(true);
    expect(variantSellable({ inventory_quantity: -3, inventory_management: "shopify", inventory_policy: "continue" })).toBe(true);
  });

  it("needs stock for a tracked variant that stops selling, and when tracking is unknown", () => {
    expect(variantSellable({ inventory_quantity: 0, inventory_management: "shopify", inventory_policy: "deny" })).toBe(false);
    expect(variantSellable({ inventory_quantity: 2, inventory_management: "shopify", inventory_policy: "deny" })).toBe(true);
    expect(variantSellable({ inventory_quantity: 0 })).toBe(false);
    expect(variantSellable({ inventory_quantity: 1 })).toBe(true);
  });
});
