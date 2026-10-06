import { describe, it, expect } from "vitest";
import { calculateAdReadinessScore } from "./ad-readiness-score";
import { deriveHealthScore } from "@/components/dashboard/derive";

describe("Unified Ad Readiness Scoring", () => {
  it("returns identical scores for both Audit and Dashboard", () => {
    const products = [
      { id: "1", name: "Ski Wax", in_stock: true, units_sold: 5, gateway_classification: "Gateway" },
      { id: "2", name: "Pant", in_stock: false, units_sold: 0 },
      { id: "3", name: "Jacket", in_stock: true, units_sold: 2 },
      { id: "4", name: "Gloves", in_stock: true, units_sold: 1 },
      { id: "5", name: "Beanie", in_stock: true, units_sold: 0 },
    ];

    const orders = {
      orders_last_30_days: 0,
      repeat_customer_rate: 0,
      revenue_last_30_days: 0,
      top_locations: [{ city: "Denver", country: "US" }],
      peak_days: ["Saturday"],
    };

    const auditResult = calculateAdReadinessScore(products, orders);
    const dashboardScore = deriveHealthScore(products, orders);

    expect(auditResult.totalScore).toBe(dashboardScore);
    expect(auditResult.totalScore).toBeGreaterThan(0);
    expect(auditResult.totalScore).toBeLessThanOrEqual(100);
  });

  it("handles empty stores gracefully", () => {
    const auditResult = calculateAdReadinessScore([], {});
    const dashboardScore = deriveHealthScore([], {});

    expect(auditResult.totalScore).toBe(0);
    expect(dashboardScore).toBe(0);
  });
});
