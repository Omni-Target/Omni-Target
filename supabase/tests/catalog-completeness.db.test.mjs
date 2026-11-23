/**
 * Real Postgres tests for catalog completeness (Phase 3, task 2; migration
 * 0044): Phase 3's product and variant fields, variant metafields, metafield
 * and metaobject definitions, referenced metaobjects and the read path's
 * products. Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 10 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

async function as(role, sql, params) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
const call = async (fn, ...args) => (await as("service_role", `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args))[0].result;
const json = (value) => JSON.stringify(value);
const catalog = (key, products, variants = [], metafields = []) => call("ingest_catalog", key, json(products), json(variants), json(metafields));

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function boundShop() {
  const shop = `c-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, key };
}

const product = (id, updated, extra = {}) => ({ shopify_id: id, title: `Product ${id}`, status: "active", tags: [], shopify_updated_at: updated, fields_version: 2, ...extra });
const variant = (id, productId, updated, extra = {}) => ({ shopify_id: id, product_shopify_id: productId, price: "10.00", shopify_updated_at: updated, ...extra });
const field = (owner, ownerId, productId, key, value, extra = {}) => ({
  owner_type: owner, owner_shopify_id: ownerId, product_shopify_id: productId, namespace: "specs", key, type: "single_line_text_field", value_excerpt: value, ...extra,
});
const T1 = "2026-11-01T00:00:00Z";
const T2 = "2026-11-02T00:00:00Z";

describe("catalog completeness (0044)", () => {
  it("stores Phase 3's product and variant fields, and records the field set each product was read with", async () => {
    const s = await boundShop();
    await q("insert into public.products (shop_key, shopify_id, title, status) values ($1, 99, 'Read before 0044', 'active')", [s.key]);
    await catalog(s.key, [product(10, T1, {
      description_excerpt: "Soft cotton", description_truncated: false, category_id: "aa-1-13-8", option_names: ["Size"], has_only_default_variant: false,
      requires_selling_plan: false, is_bundle: false, combined_listing_role: "parent", featured_image_url: "https://cdn.shopify.com/t.jpg",
      featured_image_alt: "", featured_image_width: 1075, featured_image_height: 1200, media_count: 2, online_store_url: "https://shop.example/products/t",
    })], [variant(11, 10, T1, {
      barcode: "5012345678900", available_for_sale: true, requires_components: false, harmonized_system_code: "610910", province_of_origin: "ON",
      unit_price_measurement: { measured_type: "weight", quantity_value: 250, quantity_unit: "g", reference_value: 100, reference_unit: "g" },
    })]);
    expect(await one("select fields_version, category_id, option_names, combined_listing_role, featured_image_alt, media_count from public.products where shop_key = $1 and shopify_id = 10", [s.key]))
      .toEqual({ fields_version: 2, category_id: "aa-1-13-8", option_names: ["Size"], combined_listing_role: "parent", featured_image_alt: "", media_count: 2 });
    expect(await one("select barcode, harmonized_system_code, unit_price_measurement ->> 'measured_type' as measured from public.product_variants where shop_key = $1 and shopify_id = 11", [s.key]))
      .toEqual({ barcode: "5012345678900", harmonized_system_code: "610910", measured: "weight" });
    // A product read before 0044 says so: its new fields are not "empty", they were never read.
    expect(await one("select fields_version, featured_image_url from public.products where shop_key = $1 and shopify_id = 99", [s.key]))
      .toEqual({ fields_version: null, featured_image_url: null });
    await expect(catalog(s.key, [product(12, T1, { combined_listing_role: "sibling" })])).rejects.toThrow(/combined_listing_role/);
  });

  it("writes variant metafields with their product, replaces them on each write, and drops those of removed variants", async () => {
    const s = await boundShop();
    const first = await catalog(s.key, [product(10, T1)], [variant(11, 10, T1), variant(12, 10, T1)], [
      field("product", 10, 10, "material", "Oak"),
      field("variant", 11, 10, "length", "150cm"),
      field("variant", 12, 10, "length", "160cm"),
      // A product's own metafield without product_shopify_id (Phase 2 callers): its owner is the product.
      { owner_shopify_id: 10, namespace: "specs", key: "finish", type: "single_line_text_field", value_excerpt: "Matt" },
    ]);
    expect(first).toMatchObject({ products: 1, variants: 2, metafields: 4 });
    const rows = () => q("select owner_type, owner_shopify_id, key, value_excerpt from public.metafields where shop_key = $1 order by owner_type, owner_shopify_id, key", [s.key]);
    expect(await rows()).toHaveLength(4);

    // Shopify removed variant 12 and the finish; variant 11's length changed.
    const second = await catalog(s.key, [product(10, T2)], [variant(11, 10, T2)], [field("product", 10, 10, "material", "Oak"), field("variant", 11, 10, "length", "155cm")]);
    expect(second).toMatchObject({ variants_removed: 1, metafields_removed: 2 });
    expect(await rows()).toEqual([
      { owner_type: "product", owner_shopify_id: "10", key: "material", value_excerpt: "Oak" },
      { owner_type: "variant", owner_shopify_id: "11", key: "length", value_excerpt: "155cm" },
    ]);

    // An older copy of the product (replayed import) changes nothing, its variants' metafields included.
    const stale = await catalog(s.key, [product(10, T1)], [variant(11, 10, T1)], [field("variant", 11, 10, "length", "150cm")]);
    expect(stale).toMatchObject({ products: 0, stale: 1, metafields: 0, metafields_removed: 0 });
    expect((await rows()).find((r) => r.owner_type === "variant").value_excerpt).toBe("155cm");
  });

  it("replaces the shop's definitions with Shopify's full lists", async () => {
    const s = await boundShop();
    const def = (owner, key, id) => ({ owner_type: owner, namespace: "specs", key, shopify_id: id, name: key.toUpperCase(), type: "dimension", description: null });
    await call("replace_catalog_definitions", s.key, json([def("product", "length", 1), def("variant", "width", 2)]),
      json([{ shopify_id: 3, type: "shopify--size", name: "Size", display_name_key: "label", field_definitions: [{ key: "label", name: "Label", type: "single_line_text_field" }] }]));
    const second = await call("replace_catalog_definitions", s.key, json([def("product", "length", 1)]), json([]));
    expect(second).toMatchObject({ metafield_definitions: 1, metafield_definitions_removed: 1, metaobject_definitions: 0, metaobject_definitions_removed: 1 });
    expect(await q("select owner_type, key from public.metafield_definitions where shop_key = $1", [s.key])).toEqual([{ owner_type: "product", key: "length" }]);
  });

  it("lists referenced metaobjects that are missing or stale, from product and variant reference metafields only", async () => {
    const s = await boundShop();
    await catalog(s.key, [product(10, T1)], [variant(11, 10, T1)], [
      field("product", 10, 10, "size", '["gid://shopify/Metaobject/7","gid://shopify/Metaobject/8"]', { type: "list.metaobject_reference" }),
      field("variant", 11, 10, "material", "gid://shopify/Metaobject/9", { type: "metaobject_reference" }),
      field("product", 10, 10, "note", "gid://shopify/Metaobject/50", { type: "single_line_text_field" }),
      field("product", 10, 10, "fits", '["gid://shopify/Product/60"]', { type: "list.product_reference" }),
    ]);
    expect((await call("catalog_reference_ids", s.key, null, 250)).map(Number)).toEqual([7, 8, 9]);
    expect((await call("catalog_reference_ids", s.key, null, 2)).map(Number)).toEqual([7, 8]);

    const object = (id, updated, extra = {}) => ({ shopify_id: id, type: "shopify--size", handle: `h${id}`, display_name: `Size ${id}`, fields: { label: `Size ${id}` }, shopify_updated_at: updated, ...extra });
    await call("ingest_metaobjects", s.key, json([object(7, T1), object(8, T1)]), []);
    expect((await call("catalog_reference_ids", s.key, null, 250)).map(Number)).toEqual([9]);
    // Stale: read before the cut-off.
    await q("update public.metaobjects set synced_at = now() - interval '2 days' where shop_key = $1 and shopify_id = 7", [s.key]);
    expect((await call("catalog_reference_ids", s.key, new Date(Date.now() - 86_400_000).toISOString(), 250)).map(Number)).toEqual([7, 9]);

    // Newer wins; an older copy is ignored; a metaobject Shopify no longer has is deleted.
    expect(await call("ingest_metaobjects", s.key, json([object(8, T2, { display_name: "Small" }), object(7, "2026-10-01T00:00:00Z", { display_name: "Old" })]), [9]))
      .toMatchObject({ metaobjects: 1, metaobjects_deleted: 0 });
    expect(await q("select shopify_id, display_name from public.metaobjects where shop_key = $1 order by shopify_id", [s.key]))
      .toEqual([{ shopify_id: "7", display_name: "Size 7" }, { shopify_id: "8", display_name: "Small" }]);
    await expect(call("ingest_metaobjects", s.key, json([object(10, T1, { fields: { big: "x".repeat(9000) } })]), [])).rejects.toThrow(/fields_check/);
  });

  it("gives the read path images, the field set, variant metafields with definition names, and resolved metaobjects", async () => {
    const s = await boundShop();
    await catalog(s.key, [product(10, T1, { featured_image_url: "https://cdn.shopify.com/a.jpg" })], [variant(11, 10, T1)], [
      field("product", 10, 10, "size", '["gid://shopify/Metaobject/7"]', { type: "list.metaobject_reference" }),
      field("variant", 11, 10, "length", "150cm"),
      field("variant", 11, 10, "story", "Long…", { value_truncated: true }),
    ]);
    await call("replace_catalog_definitions", s.key, json([{ owner_type: "variant", namespace: "specs", key: "length", shopify_id: 1, name: "Board length", type: "single_line_text_field" }]),
      json([{ shopify_id: 3, type: "shopify--size", name: "Size", display_name_key: "label", field_definitions: [] }]));
    await call("ingest_metaobjects", s.key, json([{ shopify_id: 7, type: "shopify--size", handle: "small", display_name: "Small", fields: { label: "Small" }, shopify_updated_at: T1 }]), []);

    const [read] = await call("insight_products", s.key, [10]);
    expect(read).toMatchObject({ id: 10, image_url: "https://cdn.shopify.com/a.jpg", fields_version: 2 });
    expect(read.metafields).toEqual([
      { owner: "product", namespace: "specs", key: "size", type: "list.metaobject_reference", value: '["gid://shopify/Metaobject/7"]', name: null },
      { owner: "variant", namespace: "specs", key: "length", type: "single_line_text_field", value: "150cm", name: "Board length" },
    ]);
    expect(await call("insight_metaobjects", s.key, [7, 70])).toEqual([
      { id: 7, type: "shopify--size", display_name: "Small", fields: { label: "Small" }, definition_name: "Size" },
    ]);
    // Another shop sees nothing of this one.
    const other = await boundShop();
    expect(await call("insight_metaobjects", other.key, [7])).toEqual([]);
  });

  it("writes only for an ingestible shop, and only as the service role", async () => {
    const s = await boundShop();
    const unbound = (await one("select coalesce(max(shop_key), 0) + 1000 as k from public.shops")).k;
    await expect(call("replace_catalog_definitions", unbound, "[]", "[]")).rejects.toThrow(/not_ingestible/);
    await expect(call("ingest_metaobjects", unbound, "[]", [])).rejects.toThrow(/not_ingestible/);
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.catalog_reference_ids($1, null, 10)", [s.key])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select * from public.metafield_definitions")).rejects.toThrow(/permission denied/);
    }
  });
});
