import { expect, it } from "vitest";
import { groundTargetingProfile } from "./recommendation-evidence";
import type { StoreData } from "./store-data";
import type { TargetingProfile } from "./insights-engine";

it("labels recommended locations with deterministic Shopify readiness", () => {
  const profile: TargetingProfile = {
    locations: [{
      name: "London",
      country: "United Kingdom",
      market_type: "international",
      source: "recommended",
      note: "Commercial demand hypothesis.",
    }],
    demographics: {
      gender: "All",
      demographic_justification: "Test",
      age_min: 25,
      age_max: 44,
      age_reasoning: "Test",
    },
    seed_interests: [],
    creative_hooks: [],
    optimization_reasoning: "Test",
    timing: { peak_days: [], launch_recommendation: "Test", reasoning: "Test" },
  };
  const store = {
    orders: { top_locations: [], peak_days: [] },
    prespend: {
      capabilities: {
        markets: { status: "available", required_scopes: [] },
        shipping: { status: "available", required_scopes: [] },
        locations: { status: "available", required_scopes: [] },
      },
      markets: [{ id: "1", name: "UK", status: "ACTIVE", countries: ["GB"] }],
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
      granted_scopes: [],
      missing_required_scopes: [],
      active_discounts: [],
      marketing_history: [],
      policies: [],
      locales: [],
    },
    data_quality: { schema_version: 3 },
  } as unknown as StoreData;

  const grounded = groundTargetingProfile(profile, store);
  expect(grounded.locations[0].note).toContain("Shopify readiness verified");
  expect(grounded.locations[0].source).toBe("recommended");
});
