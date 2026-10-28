import { describe, expect, it } from "vitest";
import {
  buildProductDecisions,
  compareProductsForTest,
  selectGatewayTestCandidate,
} from "./gateway-decision";

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

  it("keeps gateway role while return evidence changes readiness", () => {
    const stocked = products.map((product) => ({ ...product, variants: [{ inventory_quantity: 9 }], unit_cost_coverage: "complete" as const }));
    const decisions = buildProductDecisions(orders, stocked, {
      asOf,
      ingestionComplete: true,
      returnEvidence: {
        "1": {
          eligible_units: 40,
          processed_return_units: 8,
          refunded_units: 4,
          processed_return_rate: 0.2,
          risk: "review",
          window_days: 365,
          maturity_days: 60,
        },
      },
    });
    expect(decisions.get(1)?.role).toBe("Gateway");
    expect(decisions.get(1)?.test_readiness).toBe("review");
    expect(decisions.get(1)?.readiness_reasons.join(" ")).toContain("processed returns");
    expect(decisions.get(2)?.test_readiness).toBe("planning_candidate");
    expect(decisions.get(2)?.return_evidence_state).toBe("unavailable");
  });

  it("elects a high-retention, accelerating gateway with strong basket multiplier over a stale gateway with 1 more raw first order", () => {
    // Product 10: 10 first orders (all 8 months ago, 0 repeat orders, single-item $50 basket)
    // Product 20: 9 first orders (5 mature with 100% 60d repeat + 4 recent in last 30d, multi-item $95 basket on $50 price)
    // Product 30: repeat product bought in second orders
    const multiFactorOrders = [
      // 10 customers bought Product 10 eight months ago and never returned
      ...Array.from({ length: 10 }, (_, idx) => ({
        id: 1000 + idx,
        customer: { id: 100 + idx },
        created_at: "2026-01-10T12:00:00.000Z",
        subtotal_price: "50",
        line_items: [{ product_id: 10, quantity: 1, price: "50" }],
      })),
      // 5 mature customers bought Product 20 in June (multi-item $95 basket) and all returned within 30 days to buy Product 30
      ...Array.from({ length: 5 }, (_, idx) => [
        {
          id: 2000 + idx,
          customer: { id: 200 + idx },
          created_at: "2026-06-15T12:00:00.000Z",
          subtotal_price: "95",
          line_items: [
            { product_id: 20, quantity: 2, price: "50" },
          ],
        },
        {
          id: 2100 + idx,
          customer: { id: 200 + idx },
          created_at: "2026-07-05T12:00:00.000Z",
          subtotal_price: "80",
          line_items: [{ product_id: 30, quantity: 1, price: "80" }],
        },
      ]).flat(),
      // 4 recent customers bought Product 20 in August/September (accelerating momentum) and also returned for Product 30
      ...Array.from({ length: 4 }, (_, idx) => [
        {
          id: 3000 + idx,
          customer: { id: 300 + idx },
          created_at: "2026-08-25T12:00:00.000Z",
          subtotal_price: "95",
          line_items: [{ product_id: 20, quantity: 2, price: "50" }],
        },
        {
          id: 3100 + idx,
          customer: { id: 300 + idx },
          created_at: "2026-09-10T12:00:00.000Z",
          subtotal_price: "80",
          line_items: [{ product_id: 30, quantity: 1, price: "80" }],
        },
      ]).flat(),
    ];

    const catalog = [
      { id: 10, price: 50, variants: [{ id: 101, inventory_quantity: 10 }], unit_cost_coverage: "complete" as const },
      { id: 20, price: 50, variants: [{ id: 201, inventory_quantity: 10 }], unit_cost_coverage: "missing" as const },
      { id: 30, price: 80, variants: [{ id: 301, inventory_quantity: 10 }], unit_cost_coverage: "complete" as const },
    ];

    const decisions = buildProductDecisions(multiFactorOrders, catalog, {
      asOf,
      ingestionComplete: true,
    });

    const staleGateway = decisions.get(10)!;
    const activeGateway = decisions.get(20)!;

    expect(staleGateway.role).toBe("Gateway");
    expect(activeGateway.role).toBe("Gateway");
    expect(staleGateway.first_order_count).toBe(10);
    expect(activeGateway.first_order_count).toBe(9);
    expect(staleGateway.acquisition_momentum?.velocity_trend).toBe("cooling");
    expect(activeGateway.acquisition_momentum?.velocity_trend).toBe("accelerating");
    expect(activeGateway.first_order_economics?.basket_multiplier).toBe(1.9);
    expect(activeGateway.first_order_economics?.multi_item_first_order_rate).toBe(1);
    expect(activeGateway.election_score!.total).toBeGreaterThan(staleGateway.election_score!.total);

    // Even though Product 20 has 9 first orders (vs 10) and missing unit_cost_coverage,
    // its superior retention, momentum, and basket economics win the election.
    const winner = selectGatewayTestCandidate([
      { id: 10, in_stock: true, gateway_classification: staleGateway.role, product_decision: staleGateway },
      { id: 20, in_stock: true, gateway_classification: activeGateway.role, product_decision: activeGateway },
    ]);
    expect(winner?.id).toBe(20);
  });

  it("detects core variant stockouts via demand-weighted variant sales and protects ad spend", () => {
    // Product 1 has 3 variants: Size M (id 12) drove 90% of sales and is out of stock (0 qty);
    // Size XS (id 11) and XXL (id 13) are in stock (2 of 3 variants in stock unweighted = 67%, but only 10% of demand!).
    const variantOrders = [
      ...Array.from({ length: 9 }, (_, i) => ({
        id: 4000 + i,
        customer: { id: 400 + i },
        created_at: "2026-08-01T12:00:00.000Z",
        line_items: [{ product_id: 1, variant_id: 12, quantity: 2 }],
      })),
      {
        id: 4099,
        customer: { id: 499 },
        created_at: "2026-08-05T12:00:00.000Z",
        line_items: [{ product_id: 1, variant_id: 11, quantity: 2 }],
      },
      ...Array.from({ length: 6 }, (_, i) => [
        {
          id: 5000 + i,
          customer: { id: 500 + i },
          created_at: "2026-08-02T12:00:00.000Z",
          line_items: [{ product_id: 2, variant_id: 21, quantity: 1 }],
        },
        {
          id: 5100 + i,
          customer: { id: 500 + i },
          created_at: "2026-08-20T12:00:00.000Z",
          line_items: [{ product_id: 3, variant_id: 31, quantity: 1 }],
        },
      ]).flat(),
    ];

    const variantCatalog = [
      {
        id: 1,
        variants: [
          { id: 11, title: "XS", inventory_quantity: 5 },
          { id: 12, title: "M", inventory_quantity: 0 },
          { id: 13, title: "XXL", inventory_quantity: 5 },
        ],
        unit_cost_coverage: "complete" as const,
      },
      {
        id: 2,
        variants: [
          { id: 21, title: "M", inventory_quantity: 10 },
          { id: 22, title: "XXL", inventory_quantity: 0 },
        ],
        unit_cost_coverage: "complete" as const,
      },
      {
        id: 3,
        variants: [{ id: 31, title: "Default", inventory_quantity: 10 }],
        unit_cost_coverage: "complete" as const,
      },
    ];

    const decisions = buildProductDecisions(variantOrders, variantCatalog, {
      asOf,
      ingestionComplete: true,
    });

    const brokenCurveGateway = decisions.get(1)!;
    const healthyCurveGateway = decisions.get(2)!;

    expect(brokenCurveGateway.variant_stock_coverage?.unweighted_stock_share).toBe(0.67);
    expect(brokenCurveGateway.variant_stock_coverage?.demand_weighted_stock_share).toBe(0.1);
    expect(brokenCurveGateway.variant_stock_coverage?.core_variant_stockout).toBe(true);
    expect(brokenCurveGateway.variant_stock_coverage?.stocked_out_core_variants).toEqual(["M"]);
    expect(brokenCurveGateway.readiness_reasons.join(" ")).toContain("Core variant stockout");

    expect(healthyCurveGateway.variant_stock_coverage?.demand_weighted_stock_share).toBe(1);
    expect(healthyCurveGateway.variant_stock_coverage?.core_variant_stockout).toBe(false);

    // Product 2 (100% of demand in stock) ranks ahead of Product 1 (only 10% of demand in stock)
    const winner = selectGatewayTestCandidate([
      { id: 1, in_stock: true, gateway_classification: brokenCurveGateway.role, product_decision: brokenCurveGateway },
      { id: 2, in_stock: true, gateway_classification: healthyCurveGateway.role, product_decision: healthyCurveGateway },
    ]);
    expect(winner?.id).toBe(2);
  });

  it("does not badge a low-share item (< 5% of store first orders) as Gateway", () => {
    const largeStoreOrders = [
      ...Array.from({ length: 97 }, (_, i) => ({
        id: 6000 + i,
        customer: { id: 600 + i },
        created_at: "2026-08-01T12:00:00.000Z",
        line_items: [{ product_id: 1, quantity: 1 }],
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: 6200 + i,
        customer: { id: 800 + i },
        created_at: "2026-08-01T12:00:00.000Z",
        line_items: [{ product_id: 2, quantity: 1 }],
      })),
      // 6 repeat orders on Product 3 so the store has a comparison cohort (identifiedLaterOrders >= 5)
      ...Array.from({ length: 6 }, (_, i) => ({
        id: 6300 + i,
        customer: { id: 600 + i },
        created_at: "2026-08-20T12:00:00.000Z",
        line_items: [{ product_id: 3, quantity: 1 }],
      })),
    ];

    const decisions = buildProductDecisions(
      largeStoreOrders,
      [
        { id: 1, variants: [{ id: 11, inventory_quantity: 10 }], unit_cost_coverage: "complete" as const },
        { id: 2, variants: [{ id: 21, inventory_quantity: 10 }], unit_cost_coverage: "complete" as const },
        { id: 3, variants: [{ id: 31, inventory_quantity: 10 }], unit_cost_coverage: "complete" as const },
      ],
      { asOf, ingestionComplete: true }
    );

    expect(decisions.get(1)?.role).toBe("Gateway");
    expect(decisions.get(2)?.role).toBe("Insufficient Data");
  });
});
