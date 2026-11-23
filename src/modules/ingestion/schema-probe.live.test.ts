/**
 * Live schema probe (Phase 3 planning): which fields the Admin API version we
 * use exposes on the types Phase 3 reads, through a real shop's staging
 * credential. Introspection only: no shop data is read or printed. Opt-in; see
 * vitest.live.config.mjs. Refuses any database but the staging project.
 */
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const TYPES = (process.env.LIVE_TYPES ?? "ProductVariant,InventoryItem,Location,FulfillmentService,Product,Return,ReturnLineItem,LineItem,Order,Shop,Market,DeliveryProfile,Metaobject,MetafieldDefinition,Refund,RefundLineItem,ReturnReasonDefinition,ProductBundleComponent,ShopPolicy,ShopFeatures,UnverifiedReturnLineItem,ReverseFulfillmentOrder,SellingPlanGroup,TaxonomyCategory,ProductOption,MarketRegionCountry").split(",");

describe("live schema probe", () => {
  it("lists the fields of the Phase 3 types", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const out: Record<string, string> = {};
    for (const name of TYPES) {
      const data = await shopifyGraphql<{ __type: { kind: string; fields: Array<{ name: string; type: { name: string | null; kind: string; ofType?: { name: string | null; kind: string; ofType?: { name: string | null } } } }> | null; enumValues?: Array<{ name: string }> | null } | null }>(
        domain, access.accessToken,
        `query T($n: String!) { __type(name: $n) { kind fields { name type { name kind ofType { name kind ofType { name } } } } enumValues { name } } }`, { n: name });
      const t = data.__type;
      if (!t) { out[name] = "(absent)"; continue; }
      const typeName = (f: { type: { name: string | null; ofType?: { name: string | null; ofType?: { name: string | null } } } }) =>
        f.type.name ?? f.type.ofType?.name ?? f.type.ofType?.ofType?.name ?? "?";
      out[name] = t.fields ? t.fields.map((f) => `${f.name}:${typeName(f)}`).join(" ") : (t.enumValues ?? []).map((e) => e.name).join(" ");
    }
    const report = Object.entries(out).map(([name, fields]) => `## ${name}\n${fields}\n`).join("\n");
    if (process.env.LIVE_OUT) (await import("node:fs")).writeFileSync(process.env.LIVE_OUT, report);
    else console.log(report);
    expect(Object.keys(out).length).toBe(TYPES.length);
  });
});
