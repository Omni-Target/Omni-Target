/**
 * Real Postgres tests for product data-quality facts (Phase 3, task 6;
 * migration 0049): what product_quality_facts counts for each product, from
 * its variants, inventory, metafields and references. The rules that judge
 * these facts are tested in src/modules/quality/rules.test.ts. Synthetic rows.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 6 });
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

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function boundShop() {
  const shop = `q-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, key };
}
const T = "2026-11-01T00:00:00Z";

describe("product data-quality facts (0049)", () => {
  it("counts each product's variants, inventory, specifications and references", async () => {
    const s = await boundShop();
    await call("ingest_catalog", s.key, json([
      { shopify_id: 1, title: "Board", status: "active", tags: ["Shopify Collective"], fields_version: 2, description_excerpt: "Fast", description_truncated: true,
        category: "Sports > Snowboards", featured_image_url: "https://cdn.shopify.com/b.jpg", media_count: 2, shopify_updated_at: T },
      { shopify_id: 2, title: "Card", status: "active", tags: [], is_gift_card: true, shopify_updated_at: T },
    ]), json([
      { shopify_id: 11, product_shopify_id: 1, price: "300", compare_at_price: "350", unit_cost: "120", unit_cost_currency: "GBP", requires_shipping: true, weight: "3.2",
        barcode: "501", harmonized_system_code: "950611", country_of_origin: "CA", tracked: true, inventory_item_id: 111, inventory_policy: "deny", shopify_updated_at: T },
      { shopify_id: 12, product_shopify_id: 1, price: "0", compare_at_price: "0", unit_cost: "5", unit_cost_currency: "USD", requires_shipping: true, weight: "0",
        tracked: true, inventory_item_id: 112, inventory_policy: "continue", shopify_updated_at: T },
      { shopify_id: 13, product_shopify_id: 1, price: "300", requires_shipping: null, tracked: false, inventory_item_id: 113, shopify_updated_at: T },
      { shopify_id: 21, product_shopify_id: 2, price: "25", requires_shipping: false, tracked: false, shopify_updated_at: T },
    ]), json([
      { owner_type: "product", owner_shopify_id: 1, product_shopify_id: 1, namespace: "shopify", key: "size", type: "list.metaobject_reference", value_excerpt: '["gid://shopify/Metaobject/7","gid://shopify/Metaobject/8"]' },
      { owner_type: "variant", owner_shopify_id: 11, product_shopify_id: 1, namespace: "specs", key: "length", type: "dimension", value_excerpt: "{}" },
      { owner_type: "product", owner_shopify_id: 1, product_shopify_id: 1, namespace: "custom", key: "story", type: "multi_line_text_field", value_excerpt: "long", value_truncated: true },
    ]));
    await call("replace_catalog_definitions", s.key, json([{ owner_type: "variant", namespace: "specs", key: "length", shopify_id: 1, name: "Length", type: "dimension" }]), "[]");
    await call("ingest_metaobjects", s.key, json([{ shopify_id: 7, type: "shopify--size", handle: "s", fields: {}, shopify_updated_at: T }]), []);
    await call("ingest_inventory", s.key, json([{ shopify_id: 1, name: "Warehouse", is_active: true, fulfills_online_orders: true },
      { shopify_id: 3, name: "3PL", is_active: true, fulfills_online_orders: true, is_fulfillment_service: true, fulfillment_service_type: "third_party" }]),
      json([{ inventory_item_id: 111, location_shopify_id: 1, available: 4, on_hand: 4, committed: 0, incoming: 0, reserved: 0, damaged: 0, safety_stock: 0, quality_control: 0 },
            { inventory_item_id: 111, location_shopify_id: 3, available: 2, on_hand: 2, committed: 0, incoming: 0, reserved: 0, damaged: 0, safety_stock: 0, quality_control: 0 },
            { inventory_item_id: 111, location_shopify_id: 9, available: 1, on_hand: 1 }]), null);

    const rows = Object.fromEntries((await call("product_quality_facts", s.key, [1, 2, 99])).map((r) => [r.product_id, r]));
    expect(Object.keys(rows).map(Number)).toEqual([1, 2]);
    expect(rows[1]).toMatchObject({
      fields_version: 2, collective: true, has_description: true, description_truncated: true, has_category: true, has_image: true, media_count: 2,
      variants: 3, zero_price: 1, with_cost: 2, shipped: 2, shipped_without_weight: 1, shipping_unknown: 1, with_barcode: 1, with_compare_at: 2,
      compare_at_not_above: 1, with_hs_code: 1, with_origin: 1, tracked: 2, untracked: 1, keep_selling: 1,
      tracked_with_levels: 1, levels: 3, levels_unknown_location: 1, levels_partial_quantities: 1, levels_third_party: 1,
      metafields: 3, metafields_defined: 1, metafields_truncated: 1, references: 2, references_unresolved: 1,
    });
    expect([...rows[1].cost_currencies].sort()).toEqual(["GBP", "USD"]);
    expect(rows[2]).toMatchObject({ is_gift_card: true, fields_version: null, variants: 1, shipped: 0, levels: 0, metafields: 0, references: 0 });
  });

  it("is reachable by the service role only", async () => {
    const s = await boundShop();
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.product_quality_facts($1, '{1}')", [s.key])).rejects.toThrow(/permission denied/);
    }
  });
});
