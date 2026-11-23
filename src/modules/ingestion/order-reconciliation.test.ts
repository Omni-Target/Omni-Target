import { describe, expect, it } from "vitest";
import { reconcileOrders, type OrderFact } from "./order-reconciliation";

const order = (id: number, processedAt: string, extra: Partial<OrderFact> = {}): OrderFact =>
  ({ id, processedAt, cancelled: false, test: false, financialStatus: "paid", ...extra });

const WINDOW = "2024-11-01T00:00:00.000Z";

describe("reconcileOrders", () => {
  it("accounts for detailed orders, history months, and test and cancelled exclusions", () => {
    const shopify = [
      order(1, "2024-06-03T10:00:00Z"), // history month, counted by its summary
      order(2, "2024-06-20T10:00:00Z", { financialStatus: "refunded" }),
      order(3, "2025-01-05T10:00:00Z"),
      order(4, "2025-01-06T10:00:00Z", { cancelled: true, financialStatus: "voided" }),
      order(5, "2025-01-07T10:00:00Z", { test: true }),
      order(6, "2025-01-08T10:00:00Z", { financialStatus: null }),
    ];
    const mirror = shopify.filter((o) => Date.parse(o.processedAt) >= Date.parse(WINDOW));
    const result = reconcileOrders({ windowStart: WINDOW, shopify, mirror, effectiveMonths: { "2024-06-01": 2, "2025-01-01": 2 } });
    expect(result.shopify).toEqual({ total: 6, inWindow: 4, beforeWindow: 2, test: 1, cancelled: 1, counted: 4 });
    expect(result.byStatus).toEqual([
      { status: "none", shopify: 1, mirror: 1 },
      { status: "paid", shopify: 2, mirror: 2 },
      { status: "voided", shopify: 1, mirror: 1 },
    ]);
    expect(result.monthMismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports missing, extra and changed orders and wrong months instead of assuming a failed import", () => {
    const shopify = [order(1, "2025-02-01T00:00:00Z"), order(2, "2025-02-02T00:00:00Z", { financialStatus: "refunded" })];
    const mirror = [order(2, "2025-02-02T00:00:00Z"), order(9, "2025-02-03T00:00:00Z")];
    const result = reconcileOrders({ windowStart: WINDOW, shopify, mirror, effectiveMonths: { "2025-02-01": 3 } });
    expect(result.missingInMirror).toEqual([1]);
    expect(result.extraInMirror).toEqual([9]);
    expect(result.statusMismatches).toEqual([{ id: 2, shopify: "refunded", mirror: "paid" }]);
    expect(result.months).toEqual([{ month: "2025-02-01", shopifyCounted: 2, effectiveSummary: 3 }]);
    expect(result.monthMismatches).toEqual(["2025-02-01"]);
    expect(result.ok).toBe(false);
  });

  it("buckets months in UTC, as the summaries are stored", () => {
    const shopify = [order(1, "2025-02-28T23:30:00-02:00")]; // 2025-03-01 01:30 UTC
    const result = reconcileOrders({ windowStart: WINDOW, shopify, mirror: shopify, effectiveMonths: { "2025-03-01": 1 } });
    expect(result.months).toEqual([{ month: "2025-03-01", shopifyCounted: 1, effectiveSummary: 1 }]);
    expect(result.ok).toBe(true);
  });

  it("flags a summary month Shopify has no counted orders for", () => {
    const result = reconcileOrders({ windowStart: WINDOW, shopify: [], mirror: [], effectiveMonths: { "2023-01-01": 4 } });
    expect(result.monthMismatches).toEqual(["2023-01-01"]);
  });
});
