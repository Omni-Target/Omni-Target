import { describe, expect, it } from "vitest";
import { calculateBuyerOutcomes, type BuyerOutcomeOrder } from "./buyer-outcomes";

describe("buyer outcomes", () => {
  it("uses distinct identified orders and labels the median only with enough repeat buyers", () => {
    const orders: BuyerOutcomeOrder[] = [];
    for (let customer = 1; customer <= 5; customer++) {
      orders.push({ id: customer, customer: { id: customer }, created_at: "2026-01-01T00:00:00Z", total_price: "100", line_items: [{ product_id: 1 }] });
      orders.push({ id: customer + 100, customer: { id: customer }, created_at: `2026-01-${String(customer + 1).padStart(2, "0")}T00:00:00Z`, total_price: "50" });
    }
    orders.push(orders[0]);
    orders.push({ id: 999, created_at: "2026-01-01T00:00:00Z", total_price: "100" });
    const result = calculateBuyerOutcomes(orders, "2026-09-29T00:00:00Z");
    expect(result.identified_buyers).toBe(5);
    expect(result.repeat_buyers_observed).toBe(5);
    expect(result.median_days_to_second_order).toBe(3);
    expect(result.high_value_entry.size).toBe(0);
  });

  it("compares high-value first-order products with the eligible buyer baseline", () => {
    const orders: BuyerOutcomeOrder[] = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      customer: { id: index + 1 },
      created_at: "2026-01-01T00:00:00Z",
      total_price: index < 5 ? "1000" : "100",
      line_items: [{ product_id: index < 10 ? 1 : 2 }],
    }));
    const result = calculateBuyerOutcomes(orders, "2026-09-29T00:00:00Z");
    expect(result.high_value_entry.get(1)).toMatchObject({
      high_value_buyers: 5,
      high_value_first_buyers_with_product: 5,
      all_first_buyers_with_product: 10,
      high_value_share: 1,
      baseline_share: 0.2,
    });
  });

  it("maps post-entry cross-catalog product bridges, second-order timing, and 60-day value expansion", () => {
    const productNames = new Map<number, string>([
      [101, "Kasa Silk Slip"],
      [202, "Kasa Tailored Blazer"],
      [303, "Kasa Linen Trouser"],
    ]);

    // 4 customers start with Product 101 ($100):
    // - 3 of them come back within 20–30 days to buy Product 202 ($150)
    // - 1 of them comes back 25 days later to re-buy Product 101 ($100) and Product 303 ($100)
    const orders: BuyerOutcomeOrder[] = [
      { id: 1, customer: { id: 1 }, created_at: "2026-05-01T00:00:00Z", total_price: "100", line_items: [{ product_id: 101 }] },
      { id: 2, customer: { id: 1 }, created_at: "2026-05-21T00:00:00Z", total_price: "150", line_items: [{ product_id: 202 }] },

      { id: 3, customer: { id: 2 }, created_at: "2026-05-02T00:00:00Z", total_price: "100", line_items: [{ product_id: 101 }] },
      { id: 4, customer: { id: 2 }, created_at: "2026-05-26T00:00:00Z", total_price: "150", line_items: [{ product_id: 202 }] },

      { id: 5, customer: { id: 3 }, created_at: "2026-05-03T00:00:00Z", total_price: "100", line_items: [{ product_id: 101 }] },
      { id: 6, customer: { id: 3 }, created_at: "2026-06-02T00:00:00Z", total_price: "150", line_items: [{ product_id: 202 }] },

      { id: 7, customer: { id: 4 }, created_at: "2026-05-04T00:00:00Z", total_price: "100", line_items: [{ product_id: 101 }] },
      { id: 8, customer: { id: 4 }, created_at: "2026-05-29T00:00:00Z", total_price: "200", line_items: [{ product_id: 101 }, { product_id: 303 }] },
    ];

    const result = calculateBuyerOutcomes(orders, "2026-09-29T00:00:00Z", productNames);
    const bridge = result.post_entry_bridge.get(101);
    expect(bridge).toBeDefined();
    expect(bridge).toMatchObject({
      repeat_buyers_from_entry: 4,
      cross_catalog_repeat_buyers: 4,
      same_sku_repeat_buyers: 1,
      median_days_to_second_order: 24.5,
      top_next_product_id: 202,
      top_next_product_name: "Kasa Tailored Blazer",
      top_next_product_buyers: 3,
      top_next_product_share: 0.75,
      avg_first_order_spend: 100,
      avg_60d_cumulative_spend: 262.5,
      value_expansion_60d_multiple: 2.63,
    });
  });
});
