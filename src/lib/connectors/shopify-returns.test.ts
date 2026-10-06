import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateReturnEvidence, fetchShopifyReturnEvidence } from "./shopify-returns";

afterEach(() => vi.unstubAllGlobals());

describe("Shopify return evidence", () => {
  it("separates processed returns from refunds and excludes pending or cancelled orders", () => {
    const line = { quantity: 40, product: { legacyResourceId: "42" } };
    const orders = [
      {
        id: "paid", cancelledAt: null, displayFinancialStatus: "PARTIALLY_REFUNDED",
        lineItems: { nodes: [line], pageInfo: { hasNextPage: false } },
        returns: { nodes: [{ returnLineItems: { nodes: [
          { processedQuantity: 8, returnReasonDefinition: { name: "Size too small" }, fulfillmentLineItem: { lineItem: line } },
          { processedQuantity: 0, returnReasonDefinition: null, fulfillmentLineItem: { lineItem: line } },
        ], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } },
        refunds: [{ refundLineItems: { nodes: [{ quantity: 3, lineItem: line }], pageInfo: { hasNextPage: false } } }],
      },
      {
        id: "pending", cancelledAt: null, displayFinancialStatus: "PENDING",
        lineItems: { nodes: [line], pageInfo: { hasNextPage: false } },
        returns: { nodes: [], pageInfo: { hasNextPage: false } }, refunds: [],
      },
    ] as Parameters<typeof calculateReturnEvidence>[0];
    expect(calculateReturnEvidence(orders)["42"]).toMatchObject({
      eligible_units: 40,
      processed_return_units: 8,
      refunded_units: 3,
      processed_return_rate: 0.2,
      primary_reason: "Size too small",
      risk: "review",
    });
  });

  it("withholds a rate for a small cohort", () => {
    const orders = [{
      id: "small", cancelledAt: null, displayFinancialStatus: "PAID",
      lineItems: { nodes: [{ quantity: 5, product: { legacyResourceId: "9" } }], pageInfo: { hasNextPage: false } },
      returns: { nodes: [], pageInfo: { hasNextPage: false } }, refunds: [],
    }] as Parameters<typeof calculateReturnEvidence>[0];
    expect(calculateReturnEvidence(orders)["9"]).toMatchObject({
      eligible_units: 5, processed_return_rate: null, risk: "insufficient_data",
    });
  });

  it("rejects nested pagination gaps instead of publishing an incomplete return rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { orders: {
      nodes: [{
        lineItems: { nodes: [], pageInfo: { hasNextPage: true } },
        returns: { nodes: [], pageInfo: { hasNextPage: false } },
        refunds: [],
      }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } })));
    await expect(fetchShopifyReturnEvidence("example.myshopify.com", "token", "2026-09-29T00:00:00Z"))
      .rejects.toThrow("pagination incomplete");
  });
});
