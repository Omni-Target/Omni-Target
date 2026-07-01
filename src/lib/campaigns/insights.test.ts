import { describe, it, expect } from "vitest";
import { buildGenerationContext } from "@/lib/campaigns/insights";
import type { StoreInsights } from "@/components/campaigns/types";

describe("buildGenerationContext", () => {
  it("returns an empty context when the store has no products", () => {
    expect(buildGenerationContext(null, "Anything")).toEqual({
      gatewayInsight: null,
      storeDataForApi: null,
      storePrices: [],
    });
  });

  it("derives gateway insight, volume tier, and prices from store data", () => {
    const insights: StoreInsights = {
      orders: { average_order_value: 100, orders_last_30_days: 250 },
      products: [
        {
          id: "1",
          name: "Gateway Tee",
          revenue: 500,
          price: 20,
          gateway_classification: "Gateway",
          order_velocity: 3,
          repeat_purchase_rate: 0.2,
          first_time_buyer_ratio: 0.5,
        },
        {
          id: "2",
          name: "Premium Jacket",
          revenue: 1000,
          price: 200,
          gateway_classification: "Core",
          first_time_buyer_ratio: 0.3,
        },
      ],
    };

    // "gateway tee!" must match "Gateway Tee" (case- and punctuation-insensitive).
    const ctx = buildGenerationContext(insights, "gateway tee!");

    expect(ctx.gatewayInsight?.currentProductClassification).toBe("Gateway");
    expect(ctx.gatewayInsight?.currentProductName).toBe("Gateway Tee");
    expect(ctx.gatewayInsight?.bestsellerName).toBe("Premium Jacket");
    expect(ctx.gatewayInsight?.topGatewayName).toBe("Gateway Tee");
    expect(ctx.gatewayInsight?.isBestsellerGateway).toBe(false);
    expect(ctx.gatewayInsight?.currentProductVelocity).toBe(3);
    expect(ctx.gatewayInsight?.storeAov).toBe(100);
    expect(ctx.gatewayInsight?.storeBaseFtb).toBeCloseTo(0.4);
    expect(ctx.storeDataForApi).toEqual({ orderVolumeTier: "High" });
    expect(ctx.storePrices).toEqual([20, 200]);
  });

  it("maps order volume to coarse tiers at the >200 / >50 boundaries", () => {
    const tierFor = (orders: number) => {
      const insights: StoreInsights = {
        orders: { orders_last_30_days: orders },
        products: [{ id: "1", name: "X", price: 10 }],
      };
      return buildGenerationContext(insights, "X").storeDataForApi
        ?.orderVolumeTier;
    };

    expect(tierFor(250)).toBe("High");
    expect(tierFor(200)).toBe("Medium");
    expect(tierFor(51)).toBe("Medium");
    expect(tierFor(50)).toBe("Low");
    expect(tierFor(0)).toBe("Low");
  });

  it("keeps only positive numeric prices", () => {
    const insights: StoreInsights = {
      products: [
        { id: "1", name: "A", price: 10 },
        { id: "2", name: "B", price: 0 },
        { id: "3", name: "C", price: -5 },
        { id: "4", name: "D" },
      ],
    };
    expect(buildGenerationContext(insights, "A").storePrices).toEqual([10]);
  });
});
