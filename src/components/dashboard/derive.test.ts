import { describe, expect, it } from "vitest";
import { deriveLocationText, deriveBuyerLocations } from "./derive";

describe("deriveLocationText", () => {
  it("resolves primary commercial hubs when Shopify omits cities", () => {
    expect(deriveLocationText({
      top_locations: [],
      top_order_countries: [{ country: "Nigeria", order_count: 154 }],
    })).toBe("Lagos · Abuja · Port Harcourt");
  });

  it("includes top commercial diaspora hub when cross-border orders exist", () => {
    expect(deriveLocationText({
      top_locations: [],
      top_order_countries: [
        { country: "Nigeria", order_count: 134 },
        { country: "United States", order_count: 13 },
      ],
    })).toBe("Lagos · Abuja · Port Harcourt · New York");
  });

  it("prefers recorded cities and does not override verified order cities", () => {
    expect(deriveLocationText({
      top_locations: [{ city: "Lagos", country: "Nigeria" }],
      top_order_countries: [{ country: "Nigeria", order_count: 154 }],
    })).toBe("Lagos, Nigeria");
  });

  it("does not imply location data will appear later when none exists", () => {
    expect(deriveLocationText({ top_locations: [] })).toBe("No order locations available");
  });
});

describe("deriveBuyerLocations", () => {
  it("separates top 3 domestic cities and international locations with dynamic order counts", () => {
    const result = deriveBuyerLocations(
      {
        top_locations: [
          { city: "Lagos", country: "Nigeria" },
          { city: "Abuja", country: "Nigeria" },
          { city: "Ibadan", country: "Nigeria" },
          { city: "Burlington", country: "United States" },
          { city: "Nigeria", country: "Nigeria" }, // fallback country entry, should be filtered
        ],
        top_order_countries: [
          { country: "Nigeria", order_count: 137 },
          { country: "United States", order_count: 13 },
          { country: "United Kingdom", order_count: 4 },
        ],
      },
      "Nigeria",
      "NGN"
    );

    // Domestic: clean city names without redundant ", Nigeria"
    expect(result.domesticText).toBe("Lagos · Abuja · Ibadan");

    // International: Burlington (US) from recorded cities + United Kingdom from order countries
    expect(result.internationalText).toBe("Burlington (US) · United Kingdom");

    // Subtext: 17 total cross-border orders across US & UK
    expect(result.subtext).toBe(
      "Cross-border demand recorded in United States & United Kingdom (17 orders) · Ideal for high-margin diaspora targeting"
    );
    expect(result.hasInternational).toBe(true);
    expect(result.totalInternationalOrders).toBe(17);
  });

  it("handles purely domestic stores without international line or clutter", () => {
    const result = deriveBuyerLocations(
      {
        top_locations: [
          { city: "Lagos", country: "Nigeria" },
          { city: "Abuja", country: "Nigeria" },
          { city: "Ibadan", country: "Nigeria" },
        ],
        top_order_countries: [{ country: "Nigeria", order_count: 50 }],
      },
      "Nigeria",
      "NGN"
    );

    expect(result.domesticText).toBe("Lagos · Abuja · Ibadan");
    expect(result.internationalText).toBeUndefined();
    expect(result.subtext).toBe("Proven buyer locations recorded directly from your past customer orders");
    expect(result.hasInternational).toBe(false);
    expect(result.totalInternationalOrders).toBe(0);
  });

  it("works dynamically for foreign stores (e.g. UK merchant with US & Canada buyers)", () => {
    const result = deriveBuyerLocations(
      {
        top_locations: [
          { city: "London", country: "United Kingdom" },
          { city: "Manchester", country: "United Kingdom" },
          { city: "New York", country: "United States" },
          { city: "Toronto", country: "Canada" },
        ],
        top_order_countries: [
          { country: "United Kingdom", order_count: 120 },
          { country: "United States", order_count: 20 },
          { country: "Canada", order_count: 8 },
        ],
      },
      "United Kingdom",
      "GBP"
    );

    expect(result.domesticText).toBe("London · Manchester");
    expect(result.internationalText).toBe("New York (US) · Toronto (CA)");
    expect(result.subtext).toBe(
      "Cross-border demand recorded in United States & Canada (28 orders) · Ideal for high-margin diaspora targeting"
    );
    expect(result.hasInternational).toBe(true);
    expect(result.totalInternationalOrders).toBe(28);
  });
});

