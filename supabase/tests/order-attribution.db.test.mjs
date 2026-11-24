/**
 * Real Postgres tests for order attribution (Phase 3, task 8; migration 0051):
 * what is stored from the customer journey, its bounds, and the read path's
 * order page. Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { createHmac, randomBytes } from "node:crypto";
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

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const KEY = randomBytes(32);
async function boundShop() {
  const shop = `a-${tag()}.myshopify.com`;
  const shopify = Math.floor(Math.random() * 9e12) + 1e12;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [shopify, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, key, shopify };
}
const days = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const order = (s, id, processedAt, extra = {}) => ({
  shopify_id: id, name: `#${id}`, shopify_created_at: days(1), processed_at: processedAt, currency: "GBP", total_price: "40.00", financial_status: "paid",
  is_test: false, shopify_updated_at: processedAt, order_digest: createHmac("sha256", KEY).update(`${s.shopify}:order:${id}`).digest("hex"), ...extra,
});
const line = (id, orderId, productId, quantity, extra = {}) => ({ shopify_id: id, order_shopify_id: orderId, product_shopify_id: productId, quantity, current_quantity: quantity, unit_price: "10", ...extra });

describe("order attribution (0051)", () => {
  it("stores the journey's signals with the order, keeps them on later writes, and gives them to the read path", async () => {
    const s = await boundShop();
    await call("ingest_orders", s.key, json([order(s, 1, days(10), {
      visit_source: "instagram", visit_source_type: "ad", referrer_host: "l.instagram.com", landing_path: "/products/lamp",
      utm_source: "instagram", utm_medium: "paid_social", utm_campaign: "spring", first_visit_source: "google", first_visit_source_type: "seo",
      days_to_conversion: 3, customer_order_index: 2, journey_ready: true,
    })]), json([line(11, 1, 7, 1)]), "[]");
    expect(await one("select referrer_host, landing_path, utm_source, utm_campaign, customer_order_index, journey_ready from public.orders where shop_key = $1", [s.key]))
      .toEqual({ referrer_host: "l.instagram.com", landing_path: "/products/lamp", utm_source: "instagram", utm_campaign: "spring", customer_order_index: 2, journey_ready: true });
    const [page] = await call("insight_orders_page", s.key, null, null, 10);
    expect(page).toMatchObject({ referrer_host: "l.instagram.com", landing_path: "/products/lamp", utm_source: "instagram", utm_medium: "paid_social",
      utm_campaign: "spring", journey_ready: true });
    // An order Shopify knows no visit for: null, not a default.
    await call("ingest_orders", s.key, json([order(s, 2, days(9), { customer_order_index: 1, journey_ready: true })]), "[]", "[]");
    expect(await one("select referrer_host, utm_source, customer_order_index from public.orders where shop_key = $1 and shopify_id = 2", [s.key]))
      .toEqual({ referrer_host: null, utm_source: null, customer_order_index: 1 });
  });

  it("refuses values outside the bounds", async () => {
    const s = await boundShop();
    await expect(call("ingest_orders", s.key, json([order(s, 1, days(10), { customer_order_index: 0 })]), "[]", "[]")).rejects.toThrow(/customer_order_index/);
    await expect(call("ingest_orders", s.key, json([order(s, 1, days(10), { utm_campaign: "x".repeat(101) })]), "[]", "[]")).rejects.toThrow(/utm_campaign/);
    await expect(call("ingest_orders", s.key, json([order(s, 1, days(10), { visit_source_type: "Paid Ads" })]), "[]", "[]")).rejects.toThrow(/visit_source_type/);
  });
});
