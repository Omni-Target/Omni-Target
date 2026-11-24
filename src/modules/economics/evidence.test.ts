import { describe, expect, it } from "vitest";
import { normaliseEvidence, type EconomicsEvidence } from "./evidence";

describe("economics evidence normalisation (Phase 4, task 3)", () => {
  it("turns numeric strings into numbers, keeps nulls and timestamps", () => {
    const raw = {
      as_of: "2026-11-24T00:00:00Z", params: { sales_window_days: 365, discount_window_days: 180, maturity_days: 60, demand_window_days: 180, recent_days: 30 },
      currency: "GBP", taxes_included: false, freshness: {},
      store: { orders: "5", orders_unpaid: 0, discount_orders: 5, discount_amount: "8.00", discount_gross: 520, matured_orders: 4, matured_total: "522.40", matured_refunded: 170, matured_orders_returned: 1 },
      products: [{
        product_id: 1, product: {}, variants_total: 1, inventory: [],
        sales: { orders: 5, net: "492.00", first_order_at: "2026-06-01T10:00:00Z" },
        matured: { orders: 4, refunded_amount: null, net: "412" },
        variants: [{ id: 11, price: "80.00", compare_at_price: null, unit_cost: "25.50" }],
      }],
    } as unknown as EconomicsEvidence;
    const e = normaliseEvidence(raw);
    expect(e.store).toMatchObject({ orders: 5, discount_amount: 8, matured_total: 522.4 });
    expect(e.products[0].sales).toMatchObject({ net: 492, first_order_at: "2026-06-01T10:00:00Z" });
    expect(e.products[0].matured).toMatchObject({ refunded_amount: null, net: 412 });
    expect(e.products[0].variants[0]).toMatchObject({ price: 80, compare_at_price: null, unit_cost: 25.5 });
  });
});
