/**
 * Real Postgres tests for the economics evidence (Phase 4, task 3; migration 0053). SYNTHETIC FIXTURES,
 * labelled as such: the test stores have no discounts, shipping, tax, restocked returns or cancellations,
 * so every figure here is built from hand-made orders whose expected aggregates are worked out below.
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
const evidence = async (key, ids, asOf = AS_OF) => (await as("service_role",
  "select public.product_economics_evidence($1, $2, $3, 365, 180, 60, 180) as e", [key, ids, asOf]))[0].e;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function boundShop() {
  const shop = `ev-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  await q("insert into public.shop_settings (shop_key, currency, timezone, taxes_included) values ($1, 'GBP', 'Europe/London', false)", [key]);
  return key;
}

const AS_OF = "2026-11-24T00:00:00Z"; // matured before 2026-09-25; discount and demand windows from 2026-05-28; recent from 2026-10-25
const fixtures = (key) => ({
  product: (id, extra = {}) => q(`insert into public.products (shop_key, shopify_id, title, status, tags, is_gift_card, online_store_url)
    values ($1, $2, $3, $4, $5, $6, $7)`, [key, id, extra.title ?? `P${id}`, extra.status ?? "active", extra.tags ?? [], extra.gift ?? false, extra.url ?? `https://shop.test/p${id}`]),
  variant: (id, product, item, price, cost, extra = {}) => q(`insert into public.product_variants (shop_key, shopify_id, product_shopify_id, title, position,
    price, unit_cost, unit_cost_currency, inventory_item_id, tracked, inventory_policy, requires_shipping) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
    [key, id, product, `V${id}`, extra.position ?? 1, price, cost, cost === null ? null : "GBP", item, extra.tracked ?? true, extra.policy ?? "deny"]),
  location: (id, online) => q(`insert into public.inventory_locations (shop_key, shopify_id, name, country_code, is_active, fulfills_online_orders)
    values ($1, $2, $3, 'GB', true, $4)`, [key, id, `L${id}`, online]),
  level: (item, location, available) => q(`insert into public.inventory_levels (shop_key, inventory_item_id, location_shopify_id, available, on_hand,
    committed, incoming, reserved, damaged, safety_stock, quality_control, is_active) values ($1, $2, $3, $4, $4, 0, 0, 0, 0, 0, 0, true)`, [key, item, location, available]),
  order: (id, at, o) => q(`insert into public.orders (shop_key, shopify_id, shopify_created_at, processed_at, currency, financial_status, subtotal,
    total_discounts, total_shipping, total_tax, total_price, total_refunded, is_test, cancelled_at)
    values ($1, $2, $3, $3, 'GBP', $4, $5, $6, $7, $8, $5::numeric + $7::numeric + $8::numeric, $9, $10, $11)`,
    [key, id, at, o.status === undefined ? "paid" : o.status, o.subtotal, o.discounts ?? 0, o.shipping ?? 0, o.tax ?? 0, o.refunded ?? 0, o.test ?? false, o.cancelled ?? null]),
  line: (id, order, product, variant, quantity, price, discount = 0) => q(`insert into public.order_line_items (shop_key, shopify_id, order_shopify_id,
    product_shopify_id, variant_shopify_id, quantity, unit_price, total_discount) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [key, id, order, product, variant, quantity, price, discount]),
  refund: (id, order, total, linesRead = true) => q(`insert into public.refunds (shop_key, shopify_id, order_shopify_id, shopify_created_at, processed_at,
    total_refunded, currency, lines_read) values ($1, $2, $3, now(), now(), $4, 'GBP', $5)`, [key, id, order, total, linesRead]),
  refundLine: (id, refund, line, quantity, restock, subtotal) => q(`insert into public.refund_line_items (shop_key, shopify_id, refund_shopify_id,
    line_item_shopify_id, quantity, restock_type, subtotal) values ($1, $2, $3, $4, $5, $6, $7)`, [key, id, refund, line, quantity, restock, subtotal]),
  ret: (id, order, fieldsVersion = 2) => q(`insert into public.returns (shop_key, shopify_id, order_shopify_id, status, fields_version)
    values ($1, $2, $3, 'closed', $4)`, [key, id, order, fieldsVersion]),
  returnLine: (id, ret, line, quantity) => q(`insert into public.return_line_items (shop_key, shopify_id, return_shopify_id, line_item_shopify_id, quantity)
    values ($1, $2, $3, $4, $5)`, [key, id, ret, line, quantity]),
});

describe("product economics evidence (0053), synthetic fixtures", () => {
  it("aggregates sales, discounts, shipping, tax, matured refunds and returns, variants and inventory for a product", async () => {
    const key = await boundShop();
    const f = fixtures(key);
    await f.product(1); await f.product(2); await f.product(4, { title: "No sales yet" });
    await f.variant(11, 1, 110, 80, 25); await f.variant(12, 1, 120, 90, 30, { position: 2 });
    await f.variant(21, 2, 210, 20, 5); await f.variant(41, 4, 410, 50, null);
    await f.location(1, true); await f.location(2, false);
    await f.level(110, 1, 7); await f.level(110, 2, 100); await f.level(120, 1, 0);
    await q("insert into public.sync_checkpoints (shop_key, domain, updated_at) values ($1, 'inventory', '2026-11-20T00:00:00Z')", [key]);
    await q("insert into public.sync_checkpoints (shop_key, domain, updated_at, watermark) values ($1, 'orders', '2026-11-01T00:00:00Z', '2026-11-23T06:00:00Z')", [key]);

    // O1 matured, single product, £8 discount, £5 shipping, £14.40 tax, not refunded.
    await f.order(101, "2026-06-01T10:00:00Z", { subtotal: 72, discounts: 8, shipping: 5, tax: 14.4 });
    await f.line(1011, 101, 1, 11, 1, 80, 8);
    // O2 matured, single product (2 units of variant 12), £90 refunded: one unit returned and restocked.
    await f.order(102, "2026-07-01T10:00:00Z", { status: "partially_refunded", subtotal: 180, shipping: 5, tax: 36, refunded: 90 });
    await f.line(1021, 102, 1, 12, 2, 90);
    await f.refund(1021, 102, 90); await f.refundLine(10211, 1021, 1021, 1, "return", 90);
    await f.ret(1022, 102); await f.returnLine(10221, 1022, 1021, 1);
    // O3 matured, two products: £10 shipping, of which 80/100 is this product's.
    await f.order(103, "2026-08-01T10:00:00Z", { subtotal: 100, shipping: 10, tax: 20 });
    await f.line(1031, 103, 1, 11, 1, 80); await f.line(1032, 103, 2, 21, 1, 20);
    // O8 matured, cancelled before shipping and refunded: the unit is restocked by the cancellation.
    await f.order(108, "2026-09-15T10:00:00Z", { status: "refunded", subtotal: 80, refunded: 80, cancelled: "2026-09-16T00:00:00Z" });
    await f.line(1081, 108, 1, 11, 1, 80);
    await f.refund(1081, 108, 80); await f.refundLine(10811, 1081, 1081, 1, "cancel", 80);
    // O4 immature (after 2026-09-25): counted in sales, not in matured refunds.
    await f.order(104, "2026-11-01T10:00:00Z", { status: "refunded", subtotal: 80, shipping: 5, tax: 16, refunded: 80 });
    await f.line(1041, 104, 1, 11, 1, 80);
    await f.refund(1041, 104, 80); await f.refundLine(10411, 1041, 1041, 1, "no_restock", 80);
    // O5 created but never paid; O6 a test order; O7 outside the year.
    await f.order(105, "2026-10-01T10:00:00Z", { status: "voided", subtotal: 80, cancelled: "2026-10-02T00:00:00Z" }); await f.line(1051, 105, 1, 11, 1, 80);
    await f.order(106, "2026-09-01T10:00:00Z", { subtotal: 80, test: true }); await f.line(1061, 106, 1, 11, 1, 80);
    await f.order(107, "2025-01-01T10:00:00Z", { subtotal: 80 }); await f.line(1071, 107, 1, 11, 1, 80);

    const e = await evidence(key, [1, 4, 999]);
    expect(e).toMatchObject({ currency: "GBP", taxes_included: false,
      params: { sales_window_days: 365, discount_window_days: 180, maturity_days: 60, demand_window_days: 180, recent_days: 30 } });
    expect(Date.parse(e.freshness.inventory)).toBe(Date.parse("2026-11-20T00:00:00Z"));
    expect(Date.parse(e.freshness.orders)).toBe(Date.parse("2026-11-23T06:00:00Z"));
    expect(e.products.map((p) => p.product_id)).toEqual([1, 4]); // 999 does not exist

    const [a, d] = e.products;
    expect(a.product).toMatchObject({ status: "active", is_gift_card: false, collective: false, online_store_url: "https://shop.test/p1" });
    // Paid orders O1, O2, O3, O8, O4: 6 units, £500 gross, £8 discounts, £492 net. O5 is unpaid; O6 and O7 are excluded.
    expect(a.sales).toMatchObject({
      orders_created: 6, orders: 5, orders_unpaid: 1, units: 6, gross: 500, discounts: 8, net: 492,
      demand_orders: 5, demand_units: 6, recent_units: 1, discount_orders: 5, discount_gross: 500, discount_amount: 8,
      single_orders: 4, single_orders_unrefunded: 1, single_shipping: 5, multi_orders: 1, multi_orders_unrefunded: 1, multi_shipping_allocated: 8,
      orders_with_tax: 4,
    });
    // 14.4 × 72/77 + 36 × 180/185 + 20 × 80/110 + 16 × 80/85
    expect(Number(a.sales.allocated_tax)).toBeCloseTo(14.4 * 72 / 77 + 36 * 180 / 185 + 20 * 80 / 110 + 16 * 80 / 85, 6);
    expect(Date.parse(a.sales.first_order_at)).toBe(Date.parse("2026-06-01T10:00:00Z"));
    // Matured: O1, O2, O3, O8. Refunds: one returned and restocked unit (£90), one cancelled unit (£80).
    expect(a.matured).toEqual({
      orders: 4, units: 5, net: 412, refunded_amount: 170, refunded_units: 2, returned_restocked_units: 1, cancelled_restocked_units: 1,
      orders_refunded: 2, returns: 1, returned_units: 1, refunds_unread: 0, returns_unread: 0,
    });
    // Variants, sold first, with the mix and costs; inventory from Phase 3's availability (online only).
    expect(a.variants.map((v) => [v.id, Number(v.price), Number(v.unit_cost), v.unit_cost_currency, v.units, v.orders])).toEqual([
      [11, 80, 25, "GBP", 4, 4], [12, 90, 30, "GBP", 2, 1],
    ]);
    expect(a.variants_total).toBe(2);
    expect(a.inventory.map((i) => [i.variant_id, i.state, i.online.available])).toEqual([[11, "in_stock", 7], [12, "out_of_stock", 0]]);
    expect(a.inventory[0].locations).toBeUndefined();
    // A product with no sales: zeros, its variants, no inventory level.
    expect(d.sales).toMatchObject({ orders: 0, units: 0, net: 0 });
    expect(d.matured).toMatchObject({ orders: 0, refunded_amount: 0, returns: 0 });
    expect(d.variants.map((v) => [v.id, v.unit_cost])).toEqual([[41, null]]);
    expect(d.inventory.map((i) => i.state)).toEqual(["unknown"]);

    // Store-wide: paid O1, O2, O3, O8, O4; O5 unpaid. Matured O1, O2, O3, O8.
    expect(e.store).toMatchObject({ orders: 5, orders_unpaid: 1, discount_orders: 5, discount_amount: 8, discount_gross: 520,
      matured_orders: 4, matured_refunded: 170, matured_orders_returned: 1 });
    expect(Number(e.store.matured_total)).toBeCloseTo(91.4 + 221 + 130 + 80, 6);
  });

  it("withholds refund and return figures while lines are unread, never guessing them", async () => {
    const key = await boundShop();
    const f = fixtures(key);
    await f.product(1); await f.variant(11, 1, 110, 50, 20);
    await f.order(201, "2026-06-01T10:00:00Z", { status: "partially_refunded", subtotal: 100, refunded: 50 });
    await f.line(2011, 201, 1, 11, 2, 50);
    await f.refund(2011, 201, 50, false);
    await f.ret(2012, 201, null);
    const [p] = (await evidence(key, [1])).products;
    expect(p.matured).toMatchObject({ orders: 1, units: 2, net: 100, refunded_amount: null, refunded_units: null, returned_restocked_units: null,
      orders_refunded: null, returns: null, returned_units: null, refunds_unread: 1, returns_unread: 1 });
  });

  it("keeps each shop's evidence to itself and is bounded", async () => {
    const mine = await boundShop();
    const other = await boundShop();
    const f = fixtures(other);
    await f.product(1); await f.variant(11, 1, 110, 50, 20);
    await f.order(301, "2026-06-01T10:00:00Z", { subtotal: 50 }); await f.line(3011, 301, 1, 11, 1, 50);
    // An order without a financial status: its money is not known to have been collected, so it counts as not paid.
    await f.order(302, "2026-06-02T10:00:00Z", { status: null, subtotal: 50 }); await f.line(3021, 302, 1, 11, 1, 50);
    expect((await evidence(other, [1])).products[0].sales).toMatchObject({ orders_created: 2, orders: 1, orders_unpaid: 1 });
    expect((await evidence(other, [1])).store).toMatchObject({ orders: 1, orders_unpaid: 1 });
    expect((await evidence(mine, [1])).products).toEqual([]);
    expect((await evidence(mine, [1])).store).toMatchObject({ orders: 0, matured_orders: 0 });
    expect((await evidence(other, [1])).products[0].sales.orders).toBe(1);
    expect((await evidence(other, Array.from({ length: 300 }, (_, i) => i + 1))).products.length).toBe(1);
  });

  it("is reachable by the service role only", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.product_economics_evidence(1, '{1}', now(), 365, 180, 60, 180)")).rejects.toThrow(/permission denied/);
    }
  });
});
