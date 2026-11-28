/**
 * Real Postgres tests for product geography evidence (Phase 5, task 4; migration 0061): counts of paid orders'
 * shipping destinations at product, category and store scope; test, unpaid and out-of-window orders excluded;
 * isolation between shops; function-only access. Synthetic rows only.
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
const geography = async (key, ids) => (await as("service_role", "select public.product_geography_evidence($1, $2, $3, 365) as g", [key, ids, "2026-11-28T00:00:00Z"]))[0].g;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function shop() {
  const domain = `g-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, domain, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [domain]);
  await q(`insert into public.products (shop_key, shopify_id, title, status, category, product_type) values
    ($1, 1, 'Ankara dress', 'active', 'Apparel > Dresses', 'Dress'), ($1, 2, 'Maxi dress', 'active', 'Apparel > Dresses', null),
    ($1, 3, 'Candle', 'active', null, 'Home'), ($1, 4, 'Untyped', 'active', null, null)`, [key]);
  return key;
}
let orderId = 5000;
async function order(key, products, country, province, city, o = {}) {
  const id = ++orderId;
  await q(`insert into public.orders (shop_key, shopify_id, shopify_created_at, processed_at, currency, financial_status, total_price, is_test, ship_country_code, ship_province_code, ship_city)
    values ($1, $2, $3, $3, 'NGN', $4, 100, $5, $6, $7, $8)`, [key, id, o.at ?? "2026-11-01T10:00:00Z", o.status ?? "paid", o.test ?? false, country, province, city]);
  for (const [i, p] of products.entries()) {
    await q("insert into public.order_line_items (shop_key, shopify_id, order_shopify_id, product_shopify_id, quantity, unit_price) values ($1, $2, $3, $4, 1, 100)", [key, id * 10 + i, id, p]);
  }
}

describe("product geography evidence (0061)", () => {
  it("counts paid orders' destinations for the product, its category and the store, and nothing else", async () => {
    const key = await shop();
    await order(key, [1], "NG", "LA", "Lagos");
    await order(key, [1], "NG", "LA", "Lagos");
    await order(key, [1, 3], "NG", "FC", "Abuja");
    await order(key, [1], "GB", "ENG", "London");
    await order(key, [1], null, null, null);                                     // no shipping address (pickup, digital)
    await order(key, [2], "NG", "RI", "Port Harcourt");                          // same category
    await order(key, [3], "NG", "LA", "Lagos");                                  // another category
    await order(key, [1], "NG", "LA", "Lagos", { status: "pending" });           // unpaid
    await order(key, [1], "NG", "LA", "Lagos", { test: true });                  // test order
    await order(key, [1], "NG", "LA", "Lagos", { at: "2025-10-01T10:00:00Z" });  // outside 365 days
    const g = await geography(key, [1, 3, 4]);
    const [dress, candle, untyped] = g.products;
    expect(dress).toMatchObject({ product_id: 1, category_key: "Apparel > Dresses",
      product: { orders: 5, with_country: 4, countries: [{ country: "NG", orders: 3 }, { country: "GB", orders: 1 }],
        regions: [{ country: "NG", province: "LA", orders: 2 }, { country: "GB", province: "ENG", orders: 1 }, { country: "NG", province: "FC", orders: 1 }],
        cities: [{ country: "NG", city: "Lagos", orders: 2 }, { country: "GB", city: "London", orders: 1 }, { country: "NG", city: "Abuja", orders: 1 }] },
      category: { orders: 6, with_country: 5 } });
    // No category: the product type stands in.
    expect(candle).toMatchObject({ category_key: "Home", product: { orders: 2, with_country: 2 }, category: { orders: 2 } });
    expect(untyped).toMatchObject({ category_key: null, product: null, category: null });
    expect(g.store).toMatchObject({ orders: 7, with_country: 6, countries: [{ country: "NG", orders: 5 }, { country: "GB", orders: 1 }] });
  });

  it("keeps each shop's orders to itself, and is reachable by the service role only", async () => {
    const a = await shop();
    const b = await shop();
    await order(a, [1], "NG", "LA", "Lagos");
    const g = await geography(b, [1]);
    expect(g.store.orders).toBe(0);
    expect(g.products[0].product).toBeNull();
    await expect(as("authenticated", "select public.product_geography_evidence(1, '{1}', now(), 365)")).rejects.toThrow(/permission denied/);
    await expect(as("anon", "select public.product_geography_evidence(1, '{1}', now(), 365)")).rejects.toThrow(/permission denied/);
  });
});
