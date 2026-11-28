import { describe, expect, it } from "vitest";
import { recommendProduct } from "@/modules/economics/recommend";
import { recompute, runEconomics } from "@/modules/economics/run";
import { buildScenario, COMPLETE_COSTS, HEALTHY_80, type Scenario } from "@/modules/economics/__fixtures__/scenario";
import { POLICY_V3 } from "@/modules/economics/__fixtures__/policy-v3";
import { assessServiceability, servicedFlag, toShopMarketContext, type ShopMarketContext } from "./serviceability";

/** Phase 5, task 3: market serviceability, and its place in the order of authority. ILLUSTRATIVE shop configurations. */
const SHOP: ShopMarketContext = {
  shop_country: "NG",
  markets: [{ name: "Nigeria", status: "ACTIVE", countries: ["NG"] }, { name: "Ghana", status: "DRAFT", countries: ["GH"] },
    { name: "Europe", status: "ACTIVE", countries: ["FR", "DE"] }],
  // The General (default) profile, and one custom profile whose products are not read.
  zones: [{ profile_id: "p-general", profile_name: "General profile", applies_to_all_products: false, default_profile: true, zone_name: "Nigeria", countries: ["NG"], active_methods: 2 },
    { profile_id: "p-general", profile_name: "General profile", applies_to_all_products: false, default_profile: true, zone_name: "Ghana (no rates)", countries: ["GH"], active_methods: 0 },
    { profile_id: "p-bulky", profile_name: "Bulky items", applies_to_all_products: false, default_profile: false, zone_name: "Nigeria (bulky)", countries: ["NG"], active_methods: 1 },
    { profile_id: "p-bulky", profile_name: "Bulky items", applies_to_all_products: false, default_profile: false, zone_name: "France", countries: ["FR"], active_methods: 1 }],
  markets_read: true, shipping_read: true, synced_at: "2026-11-27T04:20:00Z",
};
const shipped = { requires_shipping: true };

describe("market serviceability", () => {
  it("serviced: an active market, and the General profile and every custom profile ship there", () => {
    const s = assessServiceability(SHOP, shipped);
    expect(s).toMatchObject({ target_country: "NG", status: "serviced", checks: { market: { state: "pass" }, shipping: { state: "pass" } } });
    expect(s.explanation).toMatch(/NG is in the active market "Nigeria".*Shipping zone "Nigeria" \(the General profile "General profile"\) ships to NG, as does every custom profile/);
    // Only a General profile: it covers every product.
    const generalOnly = { ...SHOP, zones: SHOP.zones.filter((z) => z.default_profile) };
    expect(assessServiceability(generalOnly, shipped).checks.shipping.evidence).toMatch(/and there is no custom profile/);
    // A profile that covers every item, whatever the assignments.
    const everyItem = { ...SHOP, zones: [{ profile_name: "All items", applies_to_all_products: true, default_profile: false, zone_name: "Germany", countries: ["DE"], active_methods: 1 }] };
    expect(assessServiceability(everyItem, shipped, "DE")).toMatchObject({ status: "serviced", checks: { shipping: { evidence: expect.stringMatching(/covers every item/) } } });
  });

  it("unknown when the General profile ships there but a custom profile does not (its products are not read)", () => {
    const noBulkyNigeria = { ...SHOP, zones: SHOP.zones.filter((z) => z.zone_name !== "Nigeria (bulky)") };
    expect(assessServiceability(noBulkyNigeria, shipped)).toMatchObject({ status: "unknown",
      checks: { shipping: { state: "unknown", evidence: expect.stringMatching(/custom profile "Bulky items" does not/) } } });
  });

  it("not serviced: the country is only in a draft market, or no zone has rates for it", () => {
    const ghana = assessServiceability(SHOP, shipped, "gh");
    expect(ghana).toMatchObject({ target_country: "GH", status: "not_serviced", checks: { market: { state: "fail" }, shipping: { state: "fail" } } });
    expect(ghana.explanation).toMatch(/only in a market that is not active \("Ghana", draft\).*No shipping zone with active rates ships to GH/);
    expect(assessServiceability(SHOP, shipped, "US")).toMatchObject({ status: "not_serviced", checks: { market: { evidence: "No Shopify market contains US." } } });
  });

  it("unknown, never negative, when only a custom profile ships there or the data was not read", () => {
    expect(assessServiceability(SHOP, shipped, "FR")).toMatchObject({ status: "unknown", checks: { market: { state: "pass" }, shipping: { state: "unknown" } } });
    expect(assessServiceability({ ...SHOP, markets_read: false }, shipped)).toMatchObject({ status: "unknown", checks: { market: { state: "unknown" } } });
    expect(assessServiceability({ ...SHOP, shipping_read: false }, shipped)).toMatchObject({ status: "unknown" });
    expect(assessServiceability({ ...SHOP, shop_country: null }, shipped)).toMatchObject({ status: "unknown", target_country: null });
    // Not shipped: the market alone decides; Germany has no zone, but a digital product needs none.
    expect(assessServiceability(SHOP, { requires_shipping: false }, "DE")).toMatchObject({ status: "serviced", checks: { shipping: { state: "not_needed" } } });
    // Shipping not known for the product: treated as shipped.
    expect(assessServiceability(SHOP, { requires_shipping: null }, "DE")).toMatchObject({ status: "not_serviced" });
  });

  it("a rest-of-world zone covers every country", () => {
    const world = { ...SHOP, zones: [{ profile_name: "General profile", applies_to_all_products: false, default_profile: true, zone_name: "Rest of world", countries: ["REST_OF_WORLD"], active_methods: 1 }] };
    expect(assessServiceability(world, shipped, "DE").status).toBe("serviced");
  });

  it("reads the stored shop context, treating anything not read as unknown", () => {
    const context = toShopMarketContext({ country_code: "NG", markets: SHOP.markets, delivery_summary: { zones: SHOP.zones } },
      { markets: { status: "available" }, shipping: { status: "missing_scope" } }, "2026-11-27T04:20:00Z");
    expect(context).toMatchObject({ shop_country: "NG", markets_read: true, shipping_read: false });
    expect(assessServiceability(context, shipped).status).toBe("unknown");
    // A context read before Phase 5 has no General-profile flag: a covering zone is unknown, not serviced.
    const old = toShopMarketContext({ country_code: "NG", markets: SHOP.markets,
      delivery_summary: { zones: [{ profile_name: "General profile", applies_to_all_products: false, zone_name: "Nigeria", countries: ["NG"], active_methods: 2 }] } },
      { markets: { status: "available" }, shipping: { status: "available" } }, null);
    expect(assessServiceability(old, shipped).checks.shipping).toMatchObject({ state: "unknown", evidence: expect.stringMatching(/has not been read yet/) });
    expect(toShopMarketContext(null, null, null)).toMatchObject({ shop_country: null, markets: [], zones: [], markets_read: false });
    expect([servicedFlag(assessServiceability(SHOP, shipped)), servicedFlag(assessServiceability(SHOP, shipped, "GH")),
      servicedFlag(assessServiceability(SHOP, shipped, "FR"))]).toEqual([true, false, null]);
  });
});

describe("the order of authority", () => {
  const LIMITS = { ad_test_limit: 1000, ad_max_loss: 600, ad_daily_limit: 50, ad_monthly_limit: 3000 };
  const rec = (s: Scenario, market?: ReturnType<typeof assessServiceability>) => {
    const built = buildScenario({ ...s, inputs: { ...COMPLETE_COSTS, ...LIMITS, ...s.inputs }, policy: POLICY_V3.settings });
    return recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: built.evidence.freshness,
      ...(market ? { market, targetMarketServiced: servicedFlag(market) } : {}) });
  };
  const notServiced = assessServiceability(SHOP, shipped, "GH");

  it("blocks a PILOT whose target market cannot be sold to, with no budget and the reason", () => {
    expect(rec(HEALTHY_80).verdict).toBe("PILOT");
    const blocked = rec(HEALTHY_80, notServiced);
    expect(blocked).toMatchObject({ verdict: "BLOCKED", reasons: ["TARGET_MARKET_NOT_SERVICED"], budget: { status: "zero", test_budget: 0 }, market: { status: "not_serviced" } });
  });

  it("never changes DO NOT LAUNCH or INSUFFICIENT DATA: the market is only noted", () => {
    const losing = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 70, units: 100, available: 500 }] }, notServiced);
    expect(losing).toMatchObject({ verdict: "DO_NOT_LAUNCH", reasons: ["NEGATIVE_CONTRIBUTION_MARGIN"] });
    expect(losing.notes).toContain("TARGET_MARKET_NOT_SERVICED");
    const missing = rec({ ...HEALTHY_80, variants: [{ price: 80, cost: null, units: 100, available: 500 }] }, notServiced);
    expect(missing).toMatchObject({ verdict: "INSUFFICIENT_DATA", reasons: ["UNIT_COST_MISSING"], budget: { status: "withheld" } });
    expect(missing.notes).toContain("TARGET_MARKET_NOT_SERVICED");
  });

  it("serviced and unknown change nothing (property, 200 random products)", () => {
    let seed = 11;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 200; i += 1) {
      const s: Scenario = { ...HEALTHY_80, variants: [{ price: 20 + Math.round(random() * 180), cost: random() < 0.1 ? null : 5 + Math.round(random() * 90),
        units: Math.round(random() * 150), available: Math.round(random() * 400) }], orders: Math.round(random() * 150) };
      const plain = rec(s);
      const { market: _a, ...withServiced } = rec(s, assessServiceability(SHOP, shipped));
      const { market: _b, ...withUnknown } = rec(s, assessServiceability(SHOP, shipped, "FR"));
      void _a; void _b;
      expect(withServiced).toEqual(plain);
      expect(withUnknown).toEqual(plain);
      // Not serviced: GO and PILOT become BLOCKED with no budget; every other verdict and budget is unchanged.
      const blocked = rec(s, notServiced);
      if (plain.verdict === "GO" || plain.verdict === "PILOT") expect(blocked).toMatchObject({ verdict: "BLOCKED", budget: { test_budget: 0 } });
      else expect([blocked.verdict, blocked.reasons, blocked.budget]).toEqual([plain.verdict, plain.reasons, plain.budget]);
    }
  });

  it("is recorded with the recommendation and recomputes from what is stored", () => {
    const built = buildScenario({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ...LIMITS }, policy: POLICY_V3.settings });
    const result = runEconomics({ evidence: built.evidence, policy: POLICY_V3.settings, commitments: [], monthlyLimit: 3000,
      products: [{ product: built.product, inputs: built.inputs, market: notServiced }] });
    const stored = JSON.parse(JSON.stringify(result.recommendations[0]));
    expect(stored.output).toMatchObject({ verdict: "BLOCKED", market: { target_country: "GH", status: "not_serviced" } });
    expect(stored.args.targetMarketServiced).toBe(false);
    expect(recompute(stored)).toEqual(stored.output);
  });
});
