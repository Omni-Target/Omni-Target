import { describe, expect, it } from "vitest";
import { deriveLocationText } from "./derive";

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
