import { describe, expect, it } from "vitest";
import { assessShopifyMarketReadiness } from "./shopify-readiness";
import type { StorePrespendIntelligence } from "./store-data";

function fixture(): StorePrespendIntelligence {
  return {
    granted_scopes: [],
    missing_required_scopes: [],
    capabilities: {
      markets: { status: "available", required_scopes: ["read_markets"] },
      shipping: { status: "available", required_scopes: ["read_shipping"] },
      locations: { status: "available", required_scopes: ["read_locations"] },
    },
    markets: [{ id: "1", name: "United Kingdom", status: "ACTIVE", countries: ["GB"] }],
    shipping_zones: [{
      profile_id: "1",
      profile_name: "General",
      applies_to_all_products: true,
      zone_name: "UK",
      countries: ["GB"],
      active_methods: 1,
    }],
    fulfillment_locations: [{
      id: "1",
      name: "Warehouse",
      fulfills_online_orders: true,
      has_active_inventory: true,
    }],
    active_discounts: [],
    marketing_history: [],
    policies: [],
    locales: [],
  };
}

describe("assessShopifyMarketReadiness", () => {
  it("requires an active market, shipping method, and fulfillment inventory", () => {
    expect(assessShopifyMarketReadiness(fixture(), "GB").status).toBe("ready");
  });

  it("blocks a market that is not configured for sale or shipping", () => {
    const assessment = assessShopifyMarketReadiness(fixture(), "CA");
    expect(assessment.status).toBe("blocked");
    expect(assessment.market_active).toBe(false);
    expect(assessment.shipping_available).toBe(false);
  });

  it("does not turn absent Shopify evidence into a negative claim", () => {
    expect(assessShopifyMarketReadiness(undefined, "GB").status).toBe("unknown");
  });
});
