import { describe, expect, it } from "vitest";
import { buildProductDecisions, compareProductsForTest } from "./gateway-decision";

const asOf = "2026-09-22T00:00:00.000Z";

describe("product gateway decisions", () => {
  const orders = Array.from({ length: 12 }, (_, index) => {
    const customerId = index + 1;
    return [
      {
        id: 100 + customerId,
        customer: { id: customerId },
        created_at: "2026-06-01T12:00:00.000Z",
        line_items: [
          { product_id: index < 8 ? 1 : 3 },
          ...(index < 2 ? [{ product_id: 2 }] : []),
        ],
      },
      {
        id: 200 + customerId,
        customer: { id: customerId },
        created_at: index === 0 ? "2026-08-15T12:00:00.000Z" : "2026-06-20T12:00:00.000Z",
        line_items: [{ product_id: index === 0 ? 1 : index < 8 ? 2 : 3 }],
      },
    ];
  }).flat();
  const products = [
    { id: 1, variants: [{ inventory_quantity: 0 }], unit_cost_coverage: "complete" as const },
    { id: 2, variants: [{ inventory_quantity: 9 }], unit_cost_coverage: "complete" as const },
    { id: 3, variants: [{ inventory_quantity: 9 }, { inventory_quantity: 0 }], unit_cost_coverage: "partial" as const },
  ];

  it("keeps a first-order gateway on stock hold without changing its role", () => {
    const decisions = buildProductDecisions(orders, products, { asOf, ingestionComplete: true });
    const gateway = decisions.get(1)!;
    expect(gateway.role).toBe("Gateway");
    expect(gateway.role_confidence).toBe("strong");
    expect(gateway.first_order_count).toBe(8);
    expect(gateway.later_order_count).toBe(1);
    expect(gateway.test_readiness).toBe("hold");
    expect(gateway.follow_up_60d).toEqual({
      eligible_first_order_buyers: 8,
      buyers_with_another_order: 7,
      repeat_rate: 0.875,
    });
    expect(decisions.get(2)?.role).toBe("Consideration");
    expect(decisions.get(2)?.test_readiness).toBe("planning_candidate");
    expect(decisions.get(3)?.test_readiness).toBe("review");
  });

  it("excludes immature cohorts and guest orders, and withholds role on incomplete sync", () => {
    const extraOrders = [
      ...orders,
      { id: 500, customer: { id: 50 }, created_at: "2026-09-01T00:00:00.000Z", line_items: [{ product_id: 1 }] },
      { id: 501, created_at: "2026-05-01T00:00:00.000Z", line_items: [{ product_id: 1 }] },
    ];
    const complete = buildProductDecisions(extraOrders, products, { asOf, ingestionComplete: true });
    expect(complete.get(1)?.first_order_count).toBe(9);
    expect(complete.get(1)?.follow_up_60d.eligible_first_order_buyers).toBe(8);
    const incomplete = buildProductDecisions(extraOrders, products, { asOf, ingestionComplete: false });
    expect(incomplete.get(1)?.role).toBe("Insufficient Data");
    expect(incomplete.get(1)?.role_reason).toContain("sync is incomplete");
    expect(incomplete.get(1)?.follow_up_60d.repeat_rate).toBeNull();
  });

  it("ranks a stock-ready candidate ahead of a held gateway", () => {
    const decisions = buildProductDecisions(orders, products, { asOf, ingestionComplete: true });
    const ranked = [
      { in_stock: false, gateway_classification: "Gateway", product_decision: decisions.get(1), revenue: 1_000 },
      { in_stock: true, gateway_classification: "Consideration", product_decision: decisions.get(2), revenue: 100 },
    ].sort(compareProductsForTest);
    expect(ranked[0].product_decision?.test_readiness).toBe("planning_candidate");
    expect(ranked[1].product_decision?.role).toBe("Gateway");
  });
});
