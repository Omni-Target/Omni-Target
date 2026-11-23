/**
 * Live data-quality check (Phase 3, task 6): builds a shop's snapshot from the
 * database (writing it to staging, as the worker does), then hand-checks the
 * flags of its products against Shopify's raw answer for the same products:
 * the state each field should have is derived here from Shopify's data alone,
 * not from the mirror. Products read before Phase 3's fields are skipped for
 * the fields those added. Opt-in; staging only. Writes LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Raw = Record<string, unknown>;
const RAW = `query P($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id isGiftCard description category { id } featuredMedia { id } mediaCount { count }
  variants(first: 100) { nodes { price compareAtPrice barcode inventoryItem { requiresShipping measurement { weight { value } } unitCost { amount } } } } } } }`;

describe("live data-quality flags", () => {
  it("flags each sampled product's fields as Shopify's own data says", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { syncShop } = await import("@/modules/ingestion/sync-repository");
    const { computeShopInsights } = await import("@/modules/insights/live");
    const { readShopInsights } = await import("@/modules/insights/repository");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const shop = await syncShop(domain);
    if (!shop) throw new Error("shop not ingestible");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);

    const built = await computeShopInsights(domain);
    const snapshot = await readShopInsights(shop.shopKey);
    const products = (snapshot?.data.products ?? []).filter((p) => p.quality).slice(0, Number(process.env.LIVE_SAMPLE ?? 60));
    if (!products.length) throw new Error(`no product with flags: ${JSON.stringify(built)}`);
    const { data: versions } = await supabaseAdmin.from("products").select("shopify_id, fields_version").eq("shop_key", shop.shopKey).in("shopify_id", products.map((p) => Number(p.id)));
    const phase3 = new Set((versions ?? []).filter((v) => v.fields_version === 2).map((v) => Number(v.shopify_id)));

    const mismatches: string[] = [];
    const tally: Record<string, Record<string, number>> = {};
    for (let i = 0; i < products.length; i += 25) {
      const slice = products.slice(i, i + 25);
      const { nodes } = await shopifyGraphql<{ nodes: Array<Raw | null> }>(domain, access.accessToken, RAW, { ids: slice.map((p) => `gid://shopify/Product/${p.id}`) });
      slice.forEach((product, index) => {
        const raw = nodes[index];
        if (!raw) return;
        const variants = ((raw.variants as { nodes: Raw[] }).nodes ?? []);
        const items = variants.map((v) => v.inventoryItem as Raw);
        const shipped = items.filter((it) => it.requiresShipping === true);
        const weightless = shipped.filter((it) => !Number(((it.measurement as Raw | null)?.weight as Raw | null)?.value ?? 0));
        const costed = items.filter((it) => it.unitCost);
        const barcoded = variants.filter((v) => v.barcode);
        const onSale = variants.filter((v) => v.compareAtPrice !== null);
        const expected: Record<string, string> = {
          unit_cost: costed.length === 0 ? "missing" : costed.length < variants.length ? "missing" : "present|unverified",
          category: (raw.category as Raw | null) ? "present" : "missing",
          description: typeof raw.description === "string" && raw.description.trim() ? "present" : "empty",
          weight: raw.isGiftCard ? "empty" : shipped.length === 0 ? "empty|unavailable" : weightless.length > 0 ? "missing" : "present",
          compare_at_price: onSale.length === 0 ? "empty" : "present|unverified",
        };
        if (phase3.has(Number(product.id))) {
          expected.images = (raw.featuredMedia as Raw | null) ? "present" : Number((raw.mediaCount as Raw | null)?.count ?? 0) > 0 ? "missing" : "empty";
          expected.barcode = raw.isGiftCard ? "empty" : barcoded.length === variants.length ? "present" : "missing";
        }
        for (const [field, want] of Object.entries(expected)) {
          const got = product.quality!.flags[field]?.state;
          (tally[field] ??= {})[got ?? "none"] = ((tally[field] ?? {})[got ?? "none"] ?? 0) + 1;
          if (!got || !want.split("|").includes(got)) mismatches.push(`product ${product.id} ${field}: shopify says ${want}, flagged ${got} (${product.quality!.flags[field]?.reason})`);
        }
      });
    }

    const report = { built: { outcome: built.outcome }, sampled: products.length, phase3Fields: phase3.size, tally, mismatches: mismatches.slice(0, 40), mismatchCount: mismatches.length };
    const out = JSON.stringify(report, null, 2);
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, out);
    else console.log(out);
    expect(mismatches).toEqual([]);
  }, 600_000);
});
