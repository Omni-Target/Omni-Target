import { describe, expect, it } from "vitest";
import { resolveMerchantInputs, type StoredMerchantInput } from "./inputs";

const now = new Date("2026-11-24T12:00:00Z");
const row = (patch: Partial<StoredMerchantInput>): StoredMerchantInput => ({
  product_id: 0, key: "shipping_cost_per_order", value: 5, state: "merchant_entered", currency: "GBP",
  entered_by: "user_1", entered_at: "2026-11-01T00:00:00Z", ...patch,
});

describe("resolving one product's merchant inputs (Phase 4, task 2)", () => {
  it("uses the product's override, else the shop's value, else marks it missing", () => {
    const stored = { currency: "GBP", inputs: [
      row({ key: "shipping_cost_per_order", value: 5 }),
      row({ product_id: 42, key: "shipping_cost_per_order", value: 12 }),
      row({ key: "selling_fee_rate", value: 0, state: "confirmed_none", currency: null }),
    ] };
    const for42 = resolveMerchantInputs(stored, 42, { now, staleDays: 180 });
    expect(for42.shipping_cost_per_order).toMatchObject({ value: 12, scope: "product", state: "merchant_entered" });
    expect(resolveMerchantInputs(stored, 7, { now, staleDays: 180 }).shipping_cost_per_order).toMatchObject({ value: 5, scope: "shop" });
    expect(for42.selling_fee_rate).toMatchObject({ value: 0, state: "confirmed_none" });
    // Unknown stays unknown: never zero.
    expect(for42.payment_rate).toEqual({ key: "payment_rate", value: null, state: "missing", scope: null, entered_at: null, stale: false });
  });

  it("does not use money entered in another currency, and marks old values stale", () => {
    const stored = { currency: "EUR", inputs: [
      row({ key: "shipping_cost_per_order", currency: "GBP" }),
      row({ key: "payment_rate", value: 0.02, currency: null, entered_at: "2026-01-01T00:00:00Z" }),
    ] };
    const r = resolveMerchantInputs(stored, 1, { now, staleDays: 180 });
    expect(r.shipping_cost_per_order).toMatchObject({ value: null, state: "missing", unusable: "currency_changed" });
    expect(r.payment_rate).toMatchObject({ value: 0.02, stale: true });
    expect(resolveMerchantInputs({ ...stored, currency: null }, 1, { now, staleDays: 180 }).shipping_cost_per_order.unusable).toBe("currency_changed");
  });
});
