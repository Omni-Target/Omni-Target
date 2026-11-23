/**
 * Live catalog check (Phase 3, task 2): stored product and variant fields,
 * variant metafields and referenced metaobjects, compared with Shopify's own
 * answer for the same products, read raw (not through the import's mappers).
 *
 * With LIVE_RESYNC=N, first re-reads N of the shop's products through the
 * incremental sync's by-ID path (recorded as replay events and processed here,
 * writing to staging), so a shop imported before 0044 can be checked without
 * re-importing its catalog. Products are sampled from those read with Phase 3's
 * fields (fields_version 2), at most LIVE_SAMPLE (default 50). With
 * LIVE_REFRESH_REFERENCES=1, first runs the daily references refresh (definitions
 * and stale metaobjects) and compares the stored definitions with Shopify's.
 * Opt-in; staging only. Writes its report to LIVE_OUT.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Raw = Record<string, unknown>;
const RAW = `query RawProducts($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Product {
    id updatedAt description(truncateAt: 600) category { id } options { name } hasOnlyDefaultVariant requiresSellingPlan
    hasVariantsThatRequiresComponents combinedListingRole onlineStoreUrl mediaCount { count }
    featuredMedia { preview { image { url width height } } }
    metafields(first: 50) { nodes { namespace key type value } }
    variants(first: 100) { nodes { id barcode availableForSale requiresComponents
      unitPriceMeasurement { measuredType quantityValue } inventoryItem { harmonizedSystemCode provinceCodeOfOrigin }
      metafields(first: 50) { nodes { namespace key type value } } } }
  } }
}`;
const META = `query RawMetaobjects($ids: [ID!]!) { nodes(ids: $ids) { ... on Metaobject { id type fields { key value } } } }`;
const nodes = (value: unknown) => ((value as { nodes?: Raw[] } | null)?.nodes ?? []);
const fieldSet = (list: Raw[]) => list.map((m) => `${m.namespace}.${m.key}=${String(m.value).slice(0, 1000)}`).sort();

describe("live catalog fields", () => {
  it("stores what Shopify reports for each sampled product", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).single();
    if (!shop) throw new Error("shop not modelled");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const gql = <T,>(query: string, variables?: Raw) => shopifyGraphql<T>(domain, access.accessToken, query, variables);

    const resync = Number(process.env.LIVE_RESYNC ?? 0);
    let resynced: unknown = null;
    if (resync > 0) {
      const { recordSyncEvents } = await import("./sync-repository");
      const { processShopEvents } = await import("./sync");
      const { liveSyncDeps } = await import("./sync-live");
      const { data: picked } = await supabaseAdmin.from("products").select("shopify_id, shopify_updated_at")
        .eq("shop_key", shop.shop_key).is("fields_version", null).order("shopify_id").limit(resync);
      const tag = `p3-catalog-${Date.now().toString(36)}`;
      await recordSyncEvents(domain, (picked ?? []).map((p) => ({
        webhook_id: `reconcile:${tag}:products/update:${p.shopify_id}`, topic: "products/update", triggered_at: p.shopify_updated_at,
        payload: { id: Number(p.shopify_id), updated_at: p.shopify_updated_at },
      })));
      resynced = await processShopEvents(domain, randomUUID(), liveSyncDeps(), { budgetMs: 600_000 });
    }

    const mismatches: string[] = [];
    let definitions: unknown = null;
    if (process.env.LIVE_REFRESH_REFERENCES === "1") {
      const { refreshCatalogReferences } = await import("./sync-live");
      definitions = await refreshCatalogReferences(domain);
      const listed: string[] = [];
      for (const ownerType of ["PRODUCT", "PRODUCTVARIANT"]) {
        const { metafieldDefinitions } = await gql<{ metafieldDefinitions: { nodes: Raw[] } }>(
          `query D($o: MetafieldOwnerType!) { metafieldDefinitions(ownerType: $o, first: 250) { nodes { namespace key name } } }`, { o: ownerType });
        listed.push(...metafieldDefinitions.nodes.map((d) => `${ownerType === "PRODUCT" ? "product" : "variant"}:${d.namespace}.${d.key}=${d.name}`));
      }
      const { data: storedDefinitions } = await supabaseAdmin.from("metafield_definitions").select("owner_type, namespace, key, name").eq("shop_key", shop.shop_key);
      const have = (storedDefinitions ?? []).map((d) => `${d.owner_type}:${d.namespace}.${d.key}=${d.name}`);
      if (JSON.stringify(listed.sort()) !== JSON.stringify(have.sort())) mismatches.push(`definitions: shopify ${JSON.stringify(listed)} stored ${JSON.stringify(have)}`);
    }

    const { data: stored } = await supabaseAdmin.from("products")
      .select("shopify_id, description_excerpt, description_truncated, category_id, option_names, has_only_default_variant, requires_selling_plan, is_bundle, combined_listing_role, online_store_url, media_count, featured_image_url, featured_image_width, featured_image_height")
      .eq("shop_key", shop.shop_key).eq("fields_version", 2).order("shopify_updated_at", { ascending: false }).limit(Number(process.env.LIVE_SAMPLE ?? 50));
    const sample = stored ?? [];
    if (!sample.length) throw new Error("no product read with Phase 3's fields");

    const differ = (where: string, field: string, want: unknown, got: unknown) => {
      if (JSON.stringify(want ?? null) !== JSON.stringify(got ?? null)) mismatches.push(`${where} ${field}: shopify ${JSON.stringify(want)} stored ${JSON.stringify(got)}`);
    };
    const referenced = new Set<number>();
    let variantsChecked = 0;
    let metafieldsChecked = 0;
    for (let i = 0; i < sample.length; i += 25) {
      const slice = sample.slice(i, i + 25);
      const { nodes: raw } = await gql<{ nodes: Array<Raw | null> }>(RAW, { ids: slice.map((p) => `gid://shopify/Product/${p.shopify_id}`) });
      const ids = slice.map((p) => Number(p.shopify_id));
      const [{ data: variants }, { data: metafields }] = await Promise.all([
        supabaseAdmin.from("product_variants").select("shopify_id, product_shopify_id, barcode, available_for_sale, requires_components, unit_price_measurement, harmonized_system_code, province_of_origin").eq("shop_key", shop.shop_key).in("product_shopify_id", ids),
        supabaseAdmin.from("metafields").select("owner_type, owner_shopify_id, namespace, key, value_excerpt").eq("shop_key", shop.shop_key).in("owner_type", ["product", "variant"]),
      ]);
      slice.forEach((p, index) => {
        const r = raw[index];
        const where = `product ${p.shopify_id}`;
        if (!r) { mismatches.push(`${where}: Shopify no longer has it`); return; }
        const description = typeof r.description === "string" ? r.description : null;
        differ(where, "description", description ? description.trim() || null : null, p.description_excerpt);
        differ(where, "description_truncated", description !== null && description.length >= 600 && description.endsWith("..."), p.description_truncated);
        differ(where, "category_id", (r.category as Raw | null)?.id ? String((r.category as Raw).id).split("/").pop() : null, p.category_id);
        differ(where, "option_names", ((r.options as Raw[] | null) ?? []).map((o) => o.name), p.option_names);
        differ(where, "has_only_default_variant", r.hasOnlyDefaultVariant, p.has_only_default_variant);
        differ(where, "requires_selling_plan", r.requiresSellingPlan, p.requires_selling_plan);
        differ(where, "is_bundle", r.hasVariantsThatRequiresComponents, p.is_bundle);
        differ(where, "combined_listing_role", r.combinedListingRole ? String(r.combinedListingRole).toLowerCase() : null, p.combined_listing_role);
        differ(where, "online_store_url", r.onlineStoreUrl, p.online_store_url);
        differ(where, "media_count", (r.mediaCount as Raw | null)?.count, p.media_count);
        const image = ((r.featuredMedia as Raw | null)?.preview as Raw | undefined)?.image as Raw | undefined;
        differ(where, "featured_image_url", image?.url ?? null, p.featured_image_url);
        differ(where, "featured_image_size", image ? [image.width, image.height] : null, p.featured_image_url ? [p.featured_image_width, p.featured_image_height] : null);

        const productFields = nodes(r.metafields);
        differ(where, "metafields", fieldSet(productFields), fieldSet((metafields ?? []).filter((m) => m.owner_type === "product" && Number(m.owner_shopify_id) === p.shopify_id)
          .map((m) => ({ namespace: m.namespace, key: m.key, value: m.value_excerpt }))));
        metafieldsChecked += productFields.length;
        for (const v of nodes(r.variants)) {
          const vid = Number(String(v.id).split("/").pop());
          const s = (variants ?? []).find((x) => Number(x.shopify_id) === vid);
          const vwhere = `${where} variant ${vid}`;
          if (!s) { mismatches.push(`${vwhere}: not stored`); continue; }
          variantsChecked += 1;
          differ(vwhere, "barcode", (v.barcode as string | null) || null, s.barcode);
          differ(vwhere, "available_for_sale", v.availableForSale, s.available_for_sale);
          differ(vwhere, "requires_components", v.requiresComponents, s.requires_components);
          const measured = (v.unitPriceMeasurement as Raw | null)?.measuredType;
          differ(vwhere, "unit_price_measured", measured ? String(measured).toLowerCase() : null, (s.unit_price_measurement as Raw | null)?.measured_type ?? null);
          const item = v.inventoryItem as Raw | null;
          differ(vwhere, "harmonized_system_code", item?.harmonizedSystemCode || null, s.harmonized_system_code);
          differ(vwhere, "province_of_origin", item?.provinceCodeOfOrigin || null, s.province_of_origin);
          const variantFields = nodes(v.metafields);
          metafieldsChecked += variantFields.length;
          differ(vwhere, "metafields", fieldSet(variantFields), fieldSet((metafields ?? []).filter((m) => m.owner_type === "variant" && Number(m.owner_shopify_id) === vid)
            .map((m) => ({ namespace: m.namespace, key: m.key, value: m.value_excerpt }))));
        }
        for (const m of [...productFields, ...nodes(r.variants).flatMap((v) => nodes(v.metafields))]) {
          if (/metaobject_reference|mixed_reference/.test(String(m.type))) for (const [, id] of String(m.value).matchAll(/gid:\/\/shopify\/Metaobject\/(\d+)/g)) referenced.add(Number(id));
        }
      });
    }

    // Every referenced metaobject is stored with Shopify's field values.
    const refIds = [...referenced];
    if (refIds.length) {
      const { nodes: rawObjects } = await gql<{ nodes: Array<Raw | null> }>(META, { ids: refIds.map((id) => `gid://shopify/Metaobject/${id}`) });
      const { data: storedObjects } = await supabaseAdmin.from("metaobjects").select("shopify_id, type, fields").eq("shop_key", shop.shop_key).in("shopify_id", refIds);
      refIds.forEach((id, index) => {
        const r = rawObjects[index];
        const s = (storedObjects ?? []).find((o) => Number(o.shopify_id) === id);
        if (!r) { if (s) mismatches.push(`metaobject ${id}: deleted in Shopify but stored`); return; }
        if (!s) { mismatches.push(`metaobject ${id}: not stored`); return; }
        const want = Object.fromEntries(((r.fields as Raw[]) ?? []).filter((f) => typeof f.value === "string").map((f) => [f.key, String(f.value).slice(0, 500)]));
        differ(`metaobject ${id}`, "fields", want, s.fields);
      });
    }

    const report = { definitions, products: sample.length, variants: variantsChecked, metafields: metafieldsChecked, metaobjects: refIds.length, resynced, mismatches: mismatches.slice(0, 50), mismatchCount: mismatches.length };
    const out = JSON.stringify(report, null, 2);
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, out);
    else console.log(out);
    expect(mismatches).toEqual([]);
  }, 900_000);
});
