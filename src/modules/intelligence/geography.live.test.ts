import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANNEL_RULES, channelFit } from "./channels";
import { GEOGRAPHY_RULES, productGeography } from "./geography";

/**
 * Live check (Phase 5, task 4): product geography on a staging store's real orders. Read only. Requires
 * LIVE_SHOP_DOMAIN; LIVE_OUT writes a summary.
 */
const STAGING_REF = "eraycbxedmufsdvhtrvk";

describe("live product geography", () => {
  it("places each product's buyers from its own orders, with a labelled scope, within the rules", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const repo = await import("./repository");
    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).maybeSingle();
    if (!shop) throw new Error("shop not found");
    const key = Number(shop.shop_key);
    const { data: products } = await supabaseAdmin.from("products").select("shopify_id").eq("shop_key", key).eq("status", "active").limit(60);
    const ids = (products ?? []).map((p) => Number(p.shopify_id));
    const asOf = new Date();
    const [evidence, context] = await Promise.all([repo.productGeographyEvidence(key, ids, asOf), repo.shopMarketContext(key)]);
    expect(evidence.products.length).toBe(ids.length);
    const results = ids.map((id) => productGeography(evidence, id, context?.shop_country ?? null, context));
    for (const g of results) {
      expect(["product", "category", "store", "none"]).toContain(g.scope);
      for (const l of [...g.regions, ...g.cities]) {
        expect(l.orders).toBeGreaterThanOrEqual(GEOGRAPHY_RULES.locationMinOrders);
        expect(l.orders / g.scope_orders).toBeGreaterThanOrEqual(GEOGRAPHY_RULES.locationMinShare);
        expect(l.country).toBe(g.target_country);
      }
      for (const c of g.cross_border) {
        expect(c.orders).toBeGreaterThanOrEqual(GEOGRAPHY_RULES.crossBorderMinOrders);
        expect(c.recommended).toBe(c.serviceability === "serviced");
      }
    }
    // Channel fit (task 5): measured only with enough recorded journeys; shares of attributed orders.
    const channelEvidence = await repo.productChannelEvidence(key, ids, asOf);
    const fits = ids.map((id) => channelFit(channelEvidence, id));
    for (const f of fits) {
      if (f.status === "measured") expect(f.attributed).toBeGreaterThanOrEqual(CHANNEL_RULES.minAttributedOrders);
      for (const c of f.channels) if (c.status === "supported") expect(c.share).toBeGreaterThanOrEqual(CHANNEL_RULES.supportedShare);
    }
    const scopes = results.reduce((acc: Record<string, number>, g) => ({ ...acc, [g.scope]: (acc[g.scope] ?? 0) + 1 }), {});
    const summary = { domain, as_of: asOf.toISOString(), products: ids.length, store: { orders: evidence.store.orders, with_country: evidence.store.with_country,
      countries: evidence.store.countries.slice(0, 5) }, scopes,
      channels: { store_orders: channelEvidence.store.orders, store_journey_known: channelEvidence.store.journey_known,
        statuses: fits.reduce((acc: Record<string, number>, f) => ({ ...acc, [`${f.scope}:${f.status}`]: (acc[`${f.scope}:${f.status}`] ?? 0) + 1 }), {}),
        example: fits[0]?.explanation ?? null }, examples: results.filter((g) => g.scope !== "none").slice(0, 3).map((g) => g.explanation) };
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(summary, null, 2));
  }, 300_000);
});
