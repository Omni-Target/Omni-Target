/**
 * Live shop context check (Phase 3, task 5): runs the background context sync
 * for a shop (writing to staging), compares what it stored with Shopify's raw
 * answer, then builds the shop's snapshot from the database alone and checks
 * that it carries the stored context. Opt-in; staging only. Writes LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Raw = Record<string, unknown>;
const RAW = `{ shop { name currencyCode ianaTimezone shopAddress { countryCodeV2 } plan { publicDisplayName } primaryDomain { host } shopPolicies { type } }
  shopLocales { locale primary published }
  markets(first: 50) { nodes { name status } } }`;

describe("live shop context", () => {
  it("stores the shop's context as Shopify gives it, and builds the snapshot from it", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { syncShop } = await import("@/modules/ingestion/sync-repository");
    const { syncShopContext } = await import("./context-sync");
    const { insightShopContext, readShopInsights } = await import("./repository");
    const { computeShopInsights } = await import("./live");
    const shop = await syncShop(domain);
    if (!shop) throw new Error("shop not ingestible");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);

    const sync = await syncShopContext(domain);
    const stored = await insightShopContext(shop.shopKey);
    const raw = (await shopifyGraphql<Raw>(domain, access.accessToken, RAW)) as {
      shop: { name: string; currencyCode: string; ianaTimezone: string; shopAddress: { countryCodeV2: string } | null; plan: { publicDisplayName: string };
        primaryDomain: { host: string }; shopPolicies: Array<{ type: string }> };
      shopLocales: Array<{ locale: string; primary: boolean; published: boolean }>;
      markets: { nodes: Array<{ name: string; status: string }> };
    };
    const s = stored.settings ?? {};
    const c = stored.context ?? {};
    const mismatches: string[] = [];
    const differ = (where: string, want: unknown, got: unknown) => {
      if (JSON.stringify(want ?? null) !== JSON.stringify(got ?? null)) mismatches.push(`${where}: shopify ${JSON.stringify(want)} stored ${JSON.stringify(got)}`);
    };
    differ("shop", [raw.shop.name, raw.shop.currencyCode, raw.shop.ianaTimezone, raw.shop.shopAddress?.countryCodeV2 ?? null, raw.shop.plan.publicDisplayName, raw.shop.primaryDomain.host],
      [s.name, s.currency, s.timezone, s.country_code, s.shopify_plan, s.primary_domain]);
    differ("markets", raw.markets.nodes.map((m) => `${m.name}:${m.status}`).sort(), ((s.markets as Raw[]) ?? []).map((m) => `${m.name}:${m.status}`).sort());
    differ("policies", raw.shop.shopPolicies.map((p) => p.type).sort(), (((s.policies as { items?: Raw[] })?.items) ?? []).map((p) => p.type).sort());
    differ("locales", raw.shopLocales.map((l) => `${l.locale}:${l.primary}:${l.published}`).sort(), ((c.locales as Raw[]) ?? []).map((l) => `${l.locale}:${l.primary}:${l.published}`).sort());

    // The snapshot, built from the database alone, carries what was stored.
    const built = await computeShopInsights(domain);
    const snapshot = await readShopInsights(shop.shopKey);
    const prespend = snapshot?.data.prespend;
    if (built.outcome !== "saved" || !prespend) mismatches.push(`snapshot: ${JSON.stringify(built).slice(0, 200)}`);
    else {
      differ("snapshot currency", s.currency, snapshot?.data.store?.currency);
      differ("snapshot markets", ((s.markets as Raw[]) ?? []).length, prespend.markets.length);
      differ("snapshot policies", ((((s.policies as { items?: Raw[] })?.items) ?? []).length), prespend.policies.length);
      differ("snapshot discounts", ((c.discounts as Raw[]) ?? []).length, prespend.active_discounts.length);
    }

    const report = {
      sync, settings: { name: s.name, currency: s.currency, country: s.country_code, plan: s.shopify_plan, logo: Boolean(s.logo_url),
        markets: ((s.markets as Raw[]) ?? []).length, zones: ((s.delivery_summary as { zones?: Raw[] })?.zones ?? []).length,
        policies: ((((s.policies as { items?: Raw[] })?.items) ?? []).length) },
      context: { analytics: Boolean(c.analytics), discounts: ((c.discounts as Raw[]) ?? []).length, marketing: ((c.marketing as Raw[]) ?? []).length,
        locales: ((c.locales as Raw[]) ?? []).length, capabilities: c.capabilities, warnings: c.warnings },
      snapshot: built, mismatches, mismatchCount: mismatches.length,
    };
    const out = JSON.stringify(report, null, 2);
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, out);
    else console.log(out);
    expect(mismatches).toEqual([]);
  }, 600_000);
});
