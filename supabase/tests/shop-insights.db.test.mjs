/**
 * The read path's mirror reads and stored snapshot (Phase 2, task 11; migration 0043). Synthetic rows only,
 * written through the ingestion RPCs as an import or the sync writes them.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 6 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

/** An RPC as the app calls it: service_role, with array and object arguments sent as JSON. */
async function call(fn, ...args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const values = args.map((a) => (a !== null && typeof a === "object" && !(a instanceof Date) ? JSON.stringify(a) : a));
    const { rows } = await client.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, values);
    await client.query("commit");
    return rows[0].result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function rowsOf(fn, ...args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(`select * from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
    await client.query("commit");
    return rows;
  } finally {
    client.release();
  }
}

/** insight_products takes a bigint[]: PostgREST converts the app's JSON array, pg needs a native one. */
async function productsOf(shopKey, ids) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query("select public.insight_products($1, $2::bigint[]) as result", [shopKey, ids]);
    await client.query("commit");
    return rows[0].result;
  } finally {
    client.release();
  }
}

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function boundShop() {
  const shop = `si-${tag()}.myshopify.com`;
  const shopify = Math.floor(Math.random() * 9e12) + 1e12;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop') as r", [shopify, shop, `user_${shop}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key };
}
async function finishedImport(s) {
  const { import_id: id } = await call("request_shop_import", s.key);
  await call("claim_shop_import", id, `run_${id}`, 900);
  await call("finish_shop_import", id, `run_${id}`, "succeeded", { domains: { orders: { status: "succeeded" }, catalog: { status: "succeeded" } } }, null);
}

const KEY = randomBytes(32);
const digest = (s, type, id) => createHmac("sha256", KEY).update(`${s.shopify}:${type}:${id}`).digest("hex");
const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();
const order = (s, id, processedAt, extra = {}) => ({
  shopify_id: id, name: `#${id}`, shopify_created_at: processedAt, processed_at: processedAt, currency: "GBP", total_price: "40.00", subtotal: "35.00",
  financial_status: "paid", customer_shopify_id: null, ship_country_code: "GB", ship_city: "Leeds", ship_province_code: "ENG", source_name: "web",
  is_test: false, shopify_updated_at: processedAt, customer_digest: null, order_digest: digest(s, "order", id), ...extra,
});
const line = (id, orderId, productId, extra = {}) => ({
  shopify_id: id, order_shopify_id: orderId, product_shopify_id: productId, variant_shopify_id: productId * 10, quantity: 2, current_quantity: 2,
  refunded_quantity: 0, unit_price: "17.50", ...extra,
});
const product = (id, updated, extra = {}) => ({ shopify_id: id, title: `Product ${id}`, handle: `p-${id}`, status: "active", tags: ["a"], is_gift_card: false, shopify_updated_at: updated, ...extra });
const variant = (id, productId, updated, extra = {}) => ({ shopify_id: id, product_shopify_id: productId, price: "17.50", selected_options: [], shopify_updated_at: updated, ...extra });

describe("the read path's mirror reads (0043)", () => {
  it("pages the analysed orders newest first: in the window, paid or partly refunded, not test or cancelled", async () => {
    const s = await boundShop();
    await call("ingest_orders", s.key, [
      order(s, 1, iso(-3)), order(s, 2, iso(-2), { financial_status: "partially_refunded", customer_shopify_id: 501, customer_digest: digest(s, "customer", 501) }),
      order(s, 3, iso(-1)), order(s, 4, iso(-1), { is_test: true }), order(s, 5, iso(-1), { cancelled_at: iso(-1) }),
      order(s, 6, iso(-1), { financial_status: "refunded" }), order(s, 7, iso(-1), { financial_status: "pending" }), order(s, 8, iso(-800)),
    ], [line(11, 1, 10), line(21, 2, 10), line(22, 2, 20, { quantity: 1 })], []);
    await call("ingest_customers", s.key, [{ shopify_id: 501, orders_count: 4, shopify_created_at: iso(-30), shopify_updated_at: iso(-1), digest: digest(s, "customer", 501) }]);

    const first = await call("insight_orders_page", s.key, null, null, 2);
    expect(first.map((o) => o.id)).toEqual([3, 2]);
    expect(first[1]).toMatchObject({ financial_status: "partially_refunded", customer_id: 501, customer_orders: 4, city: "Leeds", country_code: "GB", source_name: "web",
      lines: [{ product_id: 10, variant_id: 100, quantity: 2, price: 17.5 }, { product_id: 20, variant_id: 200, quantity: 1, price: 17.5 }] });
    const next = await call("insight_orders_page", s.key, first[1].processed_at, first[1].id, 2);
    expect(next.map((o) => o.id)).toEqual([1]);
    expect(await call("insight_orders_page", s.key, next[0].processed_at, next[0].id, 2)).toEqual([]);
  });

  it("lists the active catalog's size and newest products, and reads products with variants and complete metafields", async () => {
    const s = await boundShop();
    await call("ingest_catalog", s.key,
      [product(10, iso(-3)), product(20, iso(-1)), product(30, iso(-2), { status: "archived" })],
      [variant(100, 10, iso(-3), { inventory_quantity: 4, unit_cost: "5.00", unit_cost_currency: "GBP" }), variant(200, 20, iso(-1))],
      [{ owner_shopify_id: 10, namespace: "specs", key: "material", type: "single_line_text_field", value_excerpt: "Oak" },
       { owner_shopify_id: 10, namespace: "specs", key: "story", type: "multi_line_text_field", value_excerpt: "Long…", value_truncated: true }]);
    expect(await call("insight_catalog", s.key, 1)).toEqual({ active: 2, ids: [20] });
    expect(await call("insight_catalog", s.key, 10)).toEqual({ active: 2, ids: [20, 10] });

    const [lamp, archived] = await productsOf(s.key, [10, 30, 999]);
    expect(lamp).toMatchObject({
      id: 10, title: "Product 10", status: "active", tags: ["a"],
      variants: [{ id: 100, price: 17.5, inventory_quantity: 4, unit_cost: 5, unit_cost_currency: "GBP" }],
      metafields: [{ namespace: "specs", key: "material", type: "single_line_text_field", value: "Oak" }],
    });
    expect(archived).toMatchObject({ id: 30, status: "archived", variants: [], metafields: [] });
    // At most 500 ids are read: product 20 sits at position 501.
    const absent = Array.from({ length: 499 }, (_, i) => i + 1_000);
    expect((await productsOf(s.key, [10, ...absent, 20])).map((p) => p.id)).toEqual([10]);
  });
});

describe("the stored snapshot (0043)", () => {
  it("is saved and replaced per shop, only for an ingestible shop, and listed when due", async () => {
    const s = await boundShop();
    await finishedImport(s);
    const due = async (maxAge) => (await rowsOf("shops_insights_due", maxAge, 1000)).map((r) => r.shop_domain);
    expect(await due(21600)).toContain(s.shop);

    expect(await call("save_shop_insights", s.key, 9, { label: "first" }, { source: "canonical" })).toMatchObject({ saved: true });
    expect(await call("save_shop_insights", s.key, 9, { label: "second" }, {})).toMatchObject({ saved: true });
    expect(await one("select data->>'label' as label, schema_version from public.shop_insights where shop_key = $1", [s.key])).toEqual({ label: "second", schema_version: 9 });
    expect(await due(21600)).not.toContain(s.shop);
    await q("update public.shop_insights set computed_at = now() - interval '2 hours' where shop_key = $1", [s.key]);
    expect(await due(3600)).toContain(s.shop);

    await call("begin_uninstall", s.shopify, s.shop, randomUUID(), new Date().toISOString());
    await expect(call("save_shop_insights", s.key, 9, { label: "late" }, {})).rejects.toThrow(/shop_not_ingestible/);
    expect(await due(60)).not.toContain(s.shop);
  });
});
