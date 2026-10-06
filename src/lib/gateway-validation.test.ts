import { describe, expect, it } from "vitest";
import { validateGatewaySignal } from "./gateway-validation";

describe("gateway signal validation", () => {
  it("tests an earlier gateway against later first orders without claiming ad performance", () => {
    const orders = Array.from({ length: 40 }, (_, index) => {
      const first = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
      const later = new Date(Date.UTC(2026, 0, index + 2)).toISOString();
      const firstProduct = index < 28 ? (index < 20 ? 1 : 2) : (index < 34 ? 1 : 2);
      return [
        { id: index + 1, customer: { id: index + 1 }, created_at: first, line_items: [{ product_id: firstProduct }] },
        { id: index + 101, customer: { id: index + 1 }, created_at: later, line_items: [{ product_id: 2 }] },
      ];
    }).flat();
    const result = validateGatewaySignal(orders, [1, 2], "2026-09-29T00:00:00Z");
    expect(result).toMatchObject({
      candidate_product_id: 1,
      training_first_buyers: 28,
      later_first_buyers: 12,
      later_first_buyers_with_product: 6,
      later_share: 0.5,
      limitation: "historical_first_order_signal_only",
    });
  });
});
