import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectImport, sampledRatios } from "./projection";

const MB = 1024 * 1024;
const fixtures = JSON.parse(readFileSync("architecture/capacity/fixtures-2026-11-18.json", "utf8")) as {
  profiles: Record<string, { products: number; orders: number; mirror: number; shape: Record<string, number> }>;
};

describe("import projection (Phase 2 task 5)", () => {
  // The fixtures keep 36 months in detail; projected the same way (all orders in the window),
  // the raw projection must land within 25% of the measured mirror.
  for (const [name, profile] of Object.entries(fixtures.profiles)) {
    it(`projects the ${name} fixture within 25% of its measured size`, () => {
      const shape = profile.shape;
      const projection = projectImport({
        products: profile.products,
        variants: shape.variants,
        customers: shape.customers,
        ordersInWindow: profile.orders,
        ordersBeyondWindow: 0,
        monthsOfHistory: 36,
        metafieldsPerProduct: shape.metafields / profile.products,
        inventoryLevelsPerVariant: shape.inventory_levels / shape.variants,
        lineItemsPerOrder: shape.line_items / profile.orders,
      });
      const ratio = (projection.rawBytes - projection.breakdown.summaries) / profile.mirror;
      expect(ratio, name).toBeGreaterThan(0.75);
      expect(ratio, name).toBeLessThan(1.25);
    });
  }

  it("charges orders beyond 24 months only their summary rows", () => {
    const base = { products: 70_000, variants: 210_000, customers: 300_000, ordersInWindow: 333_000, monthsOfHistory: 24 };
    const windowOnly = projectImport({ ...base, ordersBeyondWindow: 0 });
    const withHistory = projectImport({ ...base, ordersBeyondWindow: 167_000, monthsOfHistory: 36 });
    expect(withHistory.breakdown.orders).toBe(windowOnly.breakdown.orders);
    expect(withHistory.breakdown.lineItems).toBe(windowOnly.breakdown.lineItems);
    expect(withHistory.breakdown.summaries).toBeGreaterThan(windowOnly.breakdown.summaries);
    expect(withHistory.bytes - windowOnly.bytes).toBeLessThan(80 * MB);
  });

  it("sizes a catalog-heavy shop by its own shape (omni-beta: 100k products, 1 variant and ~0 metafields each)", () => {
    const sampled = sampledRatios({ products: 250, metafields: 0, variants: 250, inventoryLevels: 250 });
    const projection = projectImport({
      products: 100_027, variants: 100_036, customers: 60, ordersInWindow: 151, ordersBeyondWindow: 0, monthsOfHistory: 3,
      lineItemsPerOrder: 266 / 151, ...sampled,
    });
    expect(projection.rawBytes / MB).toBeGreaterThan(110);
    expect(projection.rawBytes / MB).toBeLessThan(130);
    // The task 10 average (4,100 bytes per product) would have projected about 3.4 times as much.
    expect((100_027 * 4_100) / projection.rawBytes).toBeGreaterThan(3);
  });

  it("refuses impossible counts", () => {
    expect(() => projectImport({ products: -1, variants: 0, customers: 0, ordersInWindow: 0, ordersBeyondWindow: 0, monthsOfHistory: 0 })).toThrow();
    expect(sampledRatios({ products: 0, metafields: 0, variants: 0, inventoryLevels: 0 })).toEqual({ metafieldsPerProduct: undefined, inventoryLevelsPerVariant: undefined });
  });
});
