import { describe, expect, it } from "vitest";
import type { StorePrespendIntelligence } from "@/lib/store-data";
import { CONTEXT_STALE_MS, fromStoredContext, POLICY_TEXT_CHARS, toContextRows, type ShopDetails, type StoredShopContext } from "./context";

const details: ShopDetails = {
  name: "Omni Beta", primaryDomain: "shop.example", myshopifyDomain: "omni-beta.myshopify.com", currency: "NGN", moneyFormat: "₦{{amount}}",
  timezone: "Africa/Lagos", countryCode: "NG", provinceCode: "LA", plan: { displayName: "Development", shopifyPlus: false, partnerDevelopment: true },
  weightUnit: "KILOGRAMS", taxesIncluded: true,
};
const prespend = (): StorePrespendIntelligence => ({
  granted_scopes: ["read_products"], missing_required_scopes: [],
  capabilities: {
    markets: { status: "available", required_scopes: ["read_markets"] },
    analytics: { status: "error", required_scopes: ["read_reports"], detail: "ShopifyQL timed out" },
    product_evidence: { status: "available", required_scopes: ["read_products"] },
    locations: { status: "available", required_scopes: ["read_locations"] },
  },
  markets: [{ id: "gid://shopify/Market/1", name: "Nigeria", status: "ACTIVE", countries: ["NG"] }],
  shipping_zones: [{ profile_id: "p", profile_name: "General", applies_to_all_products: true, zone_name: "Domestic", countries: ["NG"], active_methods: 2 }],
  fulfillment_locations: [{ id: "gid://shopify/Location/9", name: "Ignored", fulfills_online_orders: true, has_active_inventory: true }],
  active_discounts: [{ id: "gid://shopify/DiscountNode/1", title: "WELCOME10", summary: "10% off", status: "ACTIVE" }],
  marketing_history: [{ id: "gid://shopify/MarketingEvent/1", source: "marketing_event", type: "AD", title: "Launch" }],
  policies: [{ type: "REFUND_POLICY", title: "Refund policy", body: "x".repeat(POLICY_TEXT_CHARS + 50), url: "https://shop.example/policies/refund-policy" }],
  locales: [{ locale: "en", primary: true, published: true }, { locale: "fr", primary: false, published: false }],
});
const stored = (rows: ReturnType<typeof toContextRows>, syncedAt: string): StoredShopContext => ({
  settings: { ...rows.settings, synced_at: syncedAt }, context: { ...rows.context, synced_at: syncedAt }, myshopify_domain: "omni-beta.myshopify.com",
  granted_scopes: ["read_products", "read_markets"], locations: [
    { id: 1, name: "Shop location", fulfills_online_orders: true, has_active_inventory: true, is_active: true },
    { id: 2, name: "Closed", fulfills_online_orders: true, has_active_inventory: false, is_active: false },
  ],
});

describe("shop context (Phase 3, task 5)", () => {
  it("stores shop details and the pre-spend datasets, bounded, and never a dataset the mirror provides", () => {
    const rows = toContextRows(details, prespend(), ["one warning"], "https://cdn.shopify.com/logo.png");
    expect(rows.settings).toMatchObject({ name: "Omni Beta", currency: "NGN", country_code: "NG", primary_locale: "en", enabled_locales: ["en"],
      shopify_plan: "Development", partner_development: true, weight_unit: "kilograms", taxes_included: true, logo_url: "https://cdn.shopify.com/logo.png" });
    const [policy] = (rows.settings.policies as { items: Array<{ body: string; truncated: boolean }> }).items;
    expect(policy.body).toHaveLength(POLICY_TEXT_CHARS);
    expect(policy.truncated).toBe(true);
    expect(Object.keys(rows.context.capabilities).sort()).toEqual(["analytics", "markets"]);
    expect(rows.context.locales).toHaveLength(2);
  });

  it("gives the stored context back in the snapshot's shapes, with locations and scopes from the mirror", () => {
    const rows = toContextRows(details, prespend(), [], null);
    const now = Date.parse("2026-11-23T12:00:00Z");
    const back = fromStoredContext(stored(rows, "2026-11-23T10:00:00Z"), now)!;
    expect(back.shop).toEqual({ name: "Omni Beta", domain: "shop.example", myshopify_domain: "omni-beta.myshopify.com", currency: "NGN", country_code: "NG", money_format: "₦{{amount}}" });
    expect(back.prespend.markets).toEqual(prespend().markets);
    expect(back.prespend.shipping_zones).toEqual(prespend().shipping_zones);
    expect(back.prespend.active_discounts).toEqual(prespend().active_discounts);
    expect(back.prespend.policies[0]).toEqual({ type: "REFUND_POLICY", title: "Refund policy", body: "x".repeat(POLICY_TEXT_CHARS), url: "https://shop.example/policies/refund-policy" });
    // Locations are the stored, active ones; never what the Shopify read gave.
    expect(back.prespend.fulfillment_locations).toEqual([{ id: "gid://shopify/Location/1", name: "Shop location", fulfills_online_orders: true, has_active_inventory: true }]);
    expect(back.prespend.capabilities.locations.status).toBe("available");
    expect(back.prespend.capabilities.analytics).toEqual({ status: "error", required_scopes: ["read_reports"], detail: "ShopifyQL timed out" });
    expect(back.prespend.granted_scopes).toEqual(["read_products", "read_markets"]);
    expect(back.warnings).toEqual([]);
  });

  it("reports a stale context with its age, and none when it was never read", () => {
    const rows = toContextRows(details, prespend(), [], null);
    const old = fromStoredContext(stored(rows, "2026-11-20T00:00:00Z"), Date.parse("2026-11-20T00:00:00Z") + CONTEXT_STALE_MS + 3_600_000)!;
    expect(old.warnings).toEqual(["Shop settings and pre-spend data were last read from Shopify 49 hours ago."]);
    expect(fromStoredContext({ settings: null, context: null, myshopify_domain: "x", granted_scopes: [], locations: [] })).toBeNull();
  });
});
