/**
 * Real Postgres tests for product channel evidence (Phase 5, task 5; migration 0062): paid orders grouped by their
 * recorded journey for the product and the store, orders without a journey marked as such, first orders counted,
 * test and unpaid orders excluded, and function-only access. Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 4 });
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
const channels = async (key, ids) => (await as("service_role", "select public.product_channel_evidence($1, $2, $3, 365) as c", [key, ids, "2026-11-28T00:00:00Z"]))[0].c;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function shop() {
  const domain = `c-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, domain, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [domain]);
  await q("insert into public.products (shop_key, shopify_id, title, status) values ($1, 1, 'Board', 'active'), ($1, 2, 'Wax', 'active')", [key]);
  return key;
}
let orderId = 7000;
async function order(key, products, o = {}) {
  const id = ++orderId;
  await q(`insert into public.orders (shop_key, shopify_id, shopify_created_at, processed_at, currency, financial_status, total_price, is_test,
      referrer_host, utm_source, utm_medium, visit_source, source_name, customer_order_index)
    values ($1, $2, '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z', 'NGN', $3, 100, $4, $5, $6, $7, $8, $9, $10)`,
    [key, id, o.status ?? "paid", o.test ?? false, o.referrer ?? null, o.utm ?? null, o.medium ?? null, o.visit ?? null, o.source ?? "web", o.index ?? null]);
  for (const [i, p] of products.entries()) {
    await q("insert into public.order_line_items (shop_key, shopify_id, order_shopify_id, product_shopify_id, quantity, unit_price) values ($1, $2, $3, $4, 1, 100)", [key, id * 10 + i, id, p]);
  }
}

describe("product channel evidence (0062)", () => {
  it("groups paid orders by journey for the product and the store, keeping unknown journeys apart", async () => {
    const key = await shop();
    await order(key, [1], { referrer: "www.google.com", visit: "google", index: 1 });
    await order(key, [1], { referrer: "www.google.com", visit: "google", index: 2 });
    await order(key, [1, 2], { utm: "instagram", medium: "paid_social", index: 1 });
    await order(key, [1], {});                                                    // no journey (created through the API)
    await order(key, [2], { utm: "klaviyo", medium: "email", index: 3 });
    await order(key, [1], { referrer: "www.google.com", status: "pending" });      // unpaid
    await order(key, [1], { referrer: "www.google.com", test: true });             // test
    const c = await channels(key, [1, 2]);
    const board = c.products.find((p) => p.product_id === 1).channels;
    expect(board).toMatchObject({ orders: 4, journey_known: 3 });
    expect(board.groups.map((g) => [g.referrer_host, g.utm_source, g.journey_known, g.orders, g.first_orders])).toEqual([
      ["www.google.com", null, true, 2, 1], [null, "instagram", true, 1, 1], [null, null, false, 1, 0]]);
    expect(c.store).toMatchObject({ orders: 5, journey_known: 4 });
    expect(c.products.find((p) => p.product_id === 2).channels).toMatchObject({ orders: 2, journey_known: 2 });
  });

  it("returns nothing for another shop's products, and is reachable by the service role only", async () => {
    const a = await shop();
    const b = await shop();
    await order(a, [1], { utm: "instagram" });
    const c = await channels(b, [1]);
    expect(c.store.orders).toBe(0);
    expect(c.products[0].channels).toBeNull();
    await expect(as("authenticated", "select public.product_channel_evidence(1, '{1}', now(), 365)")).rejects.toThrow(/permission denied/);
  });
});
