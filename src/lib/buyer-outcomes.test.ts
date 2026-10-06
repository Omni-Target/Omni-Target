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
});
