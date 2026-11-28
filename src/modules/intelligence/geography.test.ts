import { describe, expect, it } from "vitest";
import { GEOGRAPHY_RULES, normaliseGeographyEvidence, productGeography, type GeoScopeEvidence, type GeographyEvidence } from "./geography";
import type { ShopMarketContext } from "./serviceability";

/** Phase 5, task 4: product geography from paid orders' shipping destinations. ILLUSTRATIVE counts. */
const scope = (orders: number, countries: Array<[string, number]>, regions: Array<[string, string, number]>, cities: Array<[string, string, number]>): GeoScopeEvidence => ({
  orders, with_country: countries.reduce((t, [, n]) => t + n, 0), countries: countries.map(([country, n]) => ({ country, orders: n })),
  regions: regions.map(([country, province, n]) => ({ country, province, orders: n })), cities: cities.map(([country, city, n]) => ({ country, city, orders: n })),
});
const STORE = scope(900, [["NG", 820], ["GB", 50], ["US", 30]], [["NG", "LA", 500], ["NG", "FC", 200], ["NG", "RI", 120]], [["NG", "Lagos", 480], ["NG", "Abuja", 190], ["NG", "Port Harcourt", 110], ["GB", "London", 40]]);
const evidence = (product: GeoScopeEvidence | null, category: GeoScopeEvidence | null = null): GeographyEvidence =>
  ({ as_of: "2026-11-28T00:00:00Z", window_days: 365, store: STORE, products: [{ product_id: 1, category_key: "Apparel > Dresses", product, category }] });
const CONTEXT: ShopMarketContext = { shop_country: "NG", markets_read: true, shipping_read: true, synced_at: null,
  markets: [{ name: "Nigeria", status: "ACTIVE", countries: ["NG"] }, { name: "UK", status: "ACTIVE", countries: ["GB"] }],
  zones: [{ profile_name: "General", applies_to_all_products: false, default_profile: true, zone_name: "Domestic", countries: ["NG"], active_methods: 1 },
    { profile_name: "General", applies_to_all_products: false, default_profile: true, zone_name: "UK", countries: ["GB"], active_methods: 1 }] };

describe("product geography", () => {
  it("uses the product's own orders when 20 or more carry an address, and lists only locations with 5% and 3 orders", () => {
    const own = scope(40, [["NG", 30], ["GB", 10]], [["NG", "LA", 20], ["NG", "OY", 1]], [["NG", "Lagos", 18], ["NG", "Ibadan", 1], ["GB", "London", 9]]);
    const g = productGeography(evidence(own), 1, "NG", CONTEXT);
    expect(g).toMatchObject({ scope: "product", scope_orders: 40, regions: [{ name: "LA", orders: 20, share: 0.5 }], cities: [{ name: "Lagos", orders: 18, share: 0.45 }] });
    // One order never makes a city; London is abroad, not domestic.
    expect(g.cities.map((c) => c.name)).toEqual(["Lagos"]);
    expect(g.cross_border).toEqual([{ country: "GB", orders: 10, share: 0.25, serviceability: "serviced", recommended: true }]);
    expect(g.explanation).toMatch(/From 40 of the product's own paid orders.*Lagos \(18\).*Measured demand abroad: GB \(10 orders\)/);
  });

  it("falls back to the category, then the store, and says so", () => {
    const thin = scope(8, [["NG", 8]], [["NG", "LA", 8]], [["NG", "Lagos", 8]]);
    const category = scope(70, [["NG", 70]], [["NG", "FC", 40], ["NG", "LA", 30]], [["NG", "Abuja", 38], ["NG", "Lagos", 30]]);
    expect(productGeography(evidence(thin, category), 1, "NG")).toMatchObject({ scope: "category", scope_orders: 70, cities: [{ name: "Abuja" }, { name: "Lagos" }] });
    const g = productGeography(evidence(thin, scope(30, [["NG", 30]], [], [])), 1, "NG");
    expect(g).toMatchObject({ scope: "store", scope_orders: 900 });
    expect(g.explanation).toMatch(/the store's paid orders/);
  });

  it("counts cross-border demand only from 10 orders, and recommends it only where Shopify can sell and deliver", () => {
    const g = productGeography(evidence(null), 1, "NG", CONTEXT);
    expect(g.cross_border).toEqual([
      { country: "GB", orders: 50, share: 0.056, serviceability: "serviced", recommended: true },
      { country: "US", orders: 30, share: 0.033, serviceability: "not_serviced", recommended: false }]);
    expect(g.explanation).toMatch(/US \(30 orders, which Shopify cannot yet serve\)/);
    // Without the shop's market context, serviceability is unknown and nothing abroad is recommended.
    expect(productGeography(evidence(null), 1, "NG").cross_border.every((c) => c.serviceability === null && !c.recommended)).toBe(true);
    // Fewer than 10 orders: no cross-border demand at all.
    const few = scope(30, [["NG", 21], ["GB", 9]], [], []);
    expect(productGeography(evidence(few), 1, "NG").cross_border).toEqual([]);
  });

  it("says nothing about where buyers are without enough addressed orders", () => {
    const empty: GeographyEvidence = { ...evidence(null), store: scope(10, [["NG", 10]], [], []) };
    const g = productGeography(empty, 1, "NG");
    expect(g).toMatchObject({ scope: "none", scope_orders: 0, regions: [], cities: [], cross_border: [] });
    expect(g.explanation).toMatch(/Too few paid orders with a shipping address/);
  });

  it("never lists a location below the thresholds (property, 300 random scopes)", () => {
    let seed = 5;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 300; i += 1) {
      const cities: Array<[string, string, number]> = Array.from({ length: 6 }, (_, j) => ["NG", `City${j}`, Math.floor(random() * 30)]);
      const total = cities.reduce((t, [, , n]) => t + n, 0) + Math.floor(random() * 40);
      const g = productGeography(evidence(scope(total, [["NG", total]], [], cities)), 1, "NG");
      for (const c of g.cities) {
        expect(c.orders).toBeGreaterThanOrEqual(GEOGRAPHY_RULES.locationMinOrders);
        expect(c.orders / g.scope_orders).toBeGreaterThanOrEqual(GEOGRAPHY_RULES.locationMinShare);
      }
      expect(g.cities.length).toBeLessThanOrEqual(GEOGRAPHY_RULES.maxLocations);
    }
  });

  it("reads the database's evidence", () => {
    const e = normaliseGeographyEvidence({ as_of: "2026-11-28T00:00:00Z", window_days: 365,
      store: { orders: "3", with_country: 2, countries: [{ country: "NG", orders: "2" }], regions: [], cities: [] },
      products: [{ product_id: "7", category_key: null, product: null, category: null }] });
    expect(e).toMatchObject({ store: { orders: 3, countries: [{ country: "NG", orders: 2 }] }, products: [{ product_id: 7, product: null }] });
  });
});
