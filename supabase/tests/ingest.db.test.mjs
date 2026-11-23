/**
 * Real Postgres tests for the ingestion writes (Phase 2, task 4; migration
 * 0032), with redaction suppression (0031). Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 10 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

async function asService(sql, params) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
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
const call = async (fn, ...args) =>
  (await asService(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args))[0].result;
/** The ingest functions take jsonb batches: send them as JSON, as supabase-js does. */
const ingest = (fn, shopKey, ...batches) => call(fn, shopKey, ...batches.map((batch) => JSON.stringify(batch)));
const asOwner = async (fn, ...args) =>
  (await one(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args)).result;
const dbNow = async () => (await one("select clock_timestamp()::text as t")).t;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const shopifyId = () => Math.floor(Math.random() * 9e12) + 1e12;
const KEY = randomBytes(32);
const digest = (shopify, type, id) => createHmac("sha256", KEY).update(`${shopify}:${type}:${id}`).digest();

async function boundShop() {
  const shop = `i-${tag()}.myshopify.com`;
  const shopify = shopifyId();
  await asOwner("bind_shop_for_install", shopify, shop, `user_${tag()}`, null, "Test shop");
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key };
}

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();
const product = (id, updated, extra = {}) => ({
  shopify_id: id, title: `Product ${id}`, handle: `p-${id}`, status: "active", tags: ["a", "b"], is_gift_card: false,
  shopify_updated_at: updated, ...extra,
});
const variant = (id, productId, updated, extra = {}) => ({
  shopify_id: id, product_shopify_id: productId, price: "25.00", selected_options: [{ name: "Size", value: "M" }], shopify_updated_at: updated, ...extra,
});
const order = (s, id, processedAt, extra = {}) => ({
  shopify_id: id, name: `#${id}`, shopify_created_at: processedAt, processed_at: processedAt, currency: "GBP", total_price: "40.00",
  subtotal: "35.00", customer_shopify_id: null, ship_country_code: "GB", ship_city: "Leeds", ship_province_code: "ENG", is_test: false,
  shopify_updated_at: processedAt, customer_digest: null, order_digest: digest(s.shopify, "order", id).toString("hex"), ...extra,
});
const withCustomer = (s, customerId) => ({ customer_shopify_id: customerId, customer_digest: digest(s.shopify, "customer", customerId).toString("hex") });
const line = (id, orderId, extra = {}) => ({ shopify_id: id, order_shopify_id: orderId, product_shopify_id: 10, quantity: 2, current_quantity: 2, refunded_quantity: 0, unit_price: "20.00", ...extra });

describe("admission and bounds", () => {
  it("refuses a shop that is not bound to an active workspace, and an oversized batch", async () => {
    const { shop_key: unbound } = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning shop_key", [shopifyId(), `u-${tag()}.myshopify.com`]);
    await expect(ingest("ingest_catalog", unbound, [product(1, iso(0))], [], [])).rejects.toThrow(/shop_not_ingestible/);
    const s = await boundShop();
    const many = Array.from({ length: 2001 }, (_, i) => product(i + 1, iso(0)));
    await expect(ingest("ingest_catalog", s.key, many, [], [])).rejects.toThrow(/ingest_batch_too_large/);
    await call("begin_uninstall", s.shopify, s.shop, randomUUID(), await dbNow());
    await expect(ingest("ingest_orders", s.key, [order(s, 1, iso(-1))], [], [])).rejects.toThrow(/shop_not_ingestible/);
  });
});

describe("catalog", () => {
  it("writes a product unit, replays it unchanged, keeps newer data and removes what Shopify deleted", async () => {
    const s = await boundShop();
    const [older, newer] = [iso(-2), iso(-1)];
    const first = await ingest("ingest_catalog", s.key,
      [product(10, newer)],
      [variant(11, 10, newer), variant(12, 10, newer)],
      [{ owner_shopify_id: 10, namespace: "specs", key: "wattage", type: "number_integer", value_excerpt: "40" },
       { owner_shopify_id: 10, namespace: "specs", key: "colour", type: "single_line_text_field", value_excerpt: "brass" }]);
    expect(first).toMatchObject({ products: 1, stale: 0, variants: 2, metafields: 2 });
    expect(await one("select tags, status from public.products where shop_key = $1 and shopify_id = 10", [s.key])).toEqual({ tags: ["a", "b"], status: "active" });

    // An older copy (a late replay) changes nothing.
    expect(await ingest("ingest_catalog", s.key, [product(10, older, { title: "Old title" })], [variant(11, 10, older)], []))
      .toMatchObject({ products: 0, stale: 1, variants: 0 });
    expect(await one("select title from public.products where shop_key = $1 and shopify_id = 10", [s.key])).toEqual({ title: "Product 10" });

    // A newer copy without variant 12 and the colour metafield: Shopify deleted them.
    expect(await ingest("ingest_catalog", s.key, [product(10, iso(0), { title: "New title" })], [variant(11, 10, iso(0))],
      [{ owner_shopify_id: 10, namespace: "specs", key: "wattage", type: "number_integer", value_excerpt: "60" }]))
      .toMatchObject({ products: 1, variants: 1, variants_removed: 1, metafields: 1, metafields_removed: 1 });
    expect(await q("select shopify_id::int as id from public.product_variants where shop_key = $1", [s.key])).toEqual([{ id: 11 }]);
    expect(await q("select key, value_excerpt from public.metafields where shop_key = $1", [s.key])).toEqual([{ key: "wattage", value_excerpt: "60" }]);
  });
});

describe("orders", () => {
  it("writes orders with lines and refunds, skips orders beyond 24 months, and replaces removed lines", async () => {
    const s = await boundShop();
    const recent = iso(-10);
    const backdated = iso(-9);
    const result = await ingest("ingest_orders", s.key,
      [order(s, 1, recent), order(s, 2, iso(-800))],
      [line(11, 1), line(12, 1), line(21, 2)],
      [{ shopify_id: 31, order_shopify_id: 1, shopify_created_at: recent, total_refunded: "5.00", currency: "GBP" },
       { shopify_id: 32, order_shopify_id: 1, shopify_created_at: iso(-1), processed_at: backdated, total_refunded: "1.00", currency: "GBP" }]);
    expect(result).toMatchObject({ orders: 1, beyond_window: 1, stale: 0, line_items: 2, refunds: 2 });
    expect(await one("select count(*)::int as n from public.orders where shop_key = $1", [s.key])).toEqual({ n: 1 });
    // A refund's effective date (0041): processed_at as Shopify has it (backdated here), else its creation time.
    const refundDates = await q("select shopify_id::int as id, processed_at = $2::timestamptz as backdated, processed_at = shopify_created_at as created from public.refunds where shop_key = $1 order by 1",
      [s.key, backdated]);
    expect(refundDates).toEqual([{ id: 31, backdated: false, created: true }, { id: 32, backdated: true, created: false }]);

    // An order edit removed line 12.
    const edited = await ingest("ingest_orders", s.key, [order(s, 1, recent, { shopify_updated_at: iso(-1) })], [line(11, 1, { current_quantity: 1, refunded_quantity: 1 })], []);
    expect(edited).toMatchObject({ orders: 1, line_items: 1, line_items_removed: 1, refunds_removed: 2 });
    expect(await q("select shopify_id::int as id, refunded_quantity from public.order_line_items where shop_key = $1", [s.key])).toEqual([{ id: 11, refunded_quantity: 1 }]);
  });
});

describe("redaction suppression on every write path (decision 5)", () => {
  it("never restores a redacted customer or the destination of a redacted order", async () => {
    const s = await boundShop();
    // customers/redact names customer 501 and order 602.
    await call("record_customer_compliance", "customers/redact", s.shopify, s.shop, randomUUID(), new Date(), 501, [602],
      digest(s.shopify, "customer", 501), [digest(s.shopify, "order", 602)], 1);

    const result = await ingest("ingest_orders", s.key,
      [order(s, 601, iso(-5), withCustomer(s, 501)), order(s, 602, iso(-5)), order(s, 603, iso(-5), withCustomer(s, 502))], [], []);
    expect(result).toMatchObject({ orders: 3, suppressed: 2 });
    expect(await q(
      "select shopify_id::int as id, customer_shopify_id::int as buyer, ship_city, ship_province_code, ship_country_code from public.orders where shop_key = $1 order by shopify_id", [s.key]))
      .toEqual([
        { id: 601, buyer: null, ship_city: null, ship_province_code: null, ship_country_code: "GB" },
        { id: 602, buyer: null, ship_city: null, ship_province_code: null, ship_country_code: "GB" },
        { id: 603, buyer: 502, ship_city: "Leeds", ship_province_code: "ENG", ship_country_code: "GB" },
      ]);

    const customers = (ids) => ids.map((id) => ({ shopify_id: id, orders_count: 1, shopify_updated_at: iso(-1), digest: digest(s.shopify, "customer", id).toString("hex") }));
    expect(await ingest("ingest_customers", s.key, customers([501, 502]))).toEqual({ customers: 1, suppressed: 1 });
    expect(await q("select shopify_id::int as id from public.customers where shop_key = $1", [s.key])).toEqual([{ id: 502 }]);

    // A replay or retry of the same rows changes nothing.
    await ingest("ingest_orders", s.key, [order(s, 601, iso(-5), { ...withCustomer(s, 501), shopify_updated_at: iso(0) })], [], []);
    await ingest("ingest_customers", s.key, customers([501]));
    expect(await one("select customer_shopify_id from public.orders where shop_key = $1 and shopify_id = 601", [s.key])).toEqual({ customer_shopify_id: null });
    expect(await one("select count(*)::int as n from public.customers where shop_key = $1 and shopify_id = 501", [s.key])).toEqual({ n: 0 });
  });
});

describe("customers' order facts", () => {
  it("derives each customer's first and last order in batches, ignoring test and cancelled orders", async () => {
    const s = await boundShop();
    await ingest("ingest_customers", s.key, [701, 702, 703].map((id) => ({ shopify_id: id, digest: digest(s.shopify, "customer", id).toString("hex") })));
    await ingest("ingest_orders", s.key, [
      order(s, 1, iso(-30), withCustomer(s, 701)), order(s, 2, iso(-3), withCustomer(s, 701)),
      order(s, 3, iso(-40), { ...withCustomer(s, 701), is_test: true }),
      order(s, 4, iso(-50), { ...withCustomer(s, 702), cancelled_at: iso(-49) }), order(s, 5, iso(-20), withCustomer(s, 702)),
    ], [line(11, 1, { product_shopify_id: 99 })], []);

    const firstBatch = await call("derive_customer_order_facts", s.key, 0, 2);
    expect(firstBatch).toEqual({ updated: 2, next_after: 702 });
    expect(await call("derive_customer_order_facts", s.key, 702, 2)).toEqual({ updated: 0, next_after: null });
    expect(await q(`select shopify_id::int as id, first_order_shopify_id::int as first, first_order_product_shopify_ids::int[] as products,
                           first_order_at is not null as has_first, last_order_at > first_order_at as later_last
                      from public.customers where shop_key = $1 order by shopify_id`, [s.key]))
      .toEqual([
        { id: 701, first: 1, products: [99], has_first: true, later_last: true },
        { id: 702, first: 5, products: [], has_first: true, later_last: false },
        { id: 703, first: null, products: [], has_first: false, later_last: null },
      ]);
  });
});

describe("inventory, returns and checkpoints", () => {
  it("writes locations and levels with newer data winning, and returns with their lines replaced", async () => {
    const s = await boundShop();
    await ingest("ingest_inventory", s.key, [{ shopify_id: 50, name: "Warehouse", country_code: "GB", is_active: true }],
      [{ inventory_item_id: 12, location_shopify_id: 50, available: 4, on_hand: 6, shopify_updated_at: iso(-1) }]);
    expect(await ingest("ingest_inventory", s.key, [], [{ inventory_item_id: 12, location_shopify_id: 50, available: 1, shopify_updated_at: iso(-2) }]))
      .toEqual({ locations: 0, levels: 0, levels_removed: 0 });
    expect(await one("select available from public.inventory_levels where shop_key = $1", [s.key])).toEqual({ available: 4 });

    await ingest("ingest_returns", s.key, [{ shopify_id: 60, order_shopify_id: 20, status: "open" }],
      [{ shopify_id: 61, return_shopify_id: 60, quantity: 1, return_reason: "defective" }, { shopify_id: 62, return_shopify_id: 60, quantity: 1 }]);
    expect(await ingest("ingest_returns", s.key, [{ shopify_id: 60, order_shopify_id: 20, status: "closed" }], [{ shopify_id: 61, return_shopify_id: 60, quantity: 1 }]))
      .toEqual({ returns: 1, return_line_items: 1, return_line_items_removed: 1 });
  });

  it("keeps a checkpoint moving forward within one bulk operation, and resets it for a new one", async () => {
    const s = await boundShop();
    const save = (op, line) => call("save_sync_checkpoint", s.key, "orders", null, op, line, null);
    expect(await save(77, 500)).toEqual({ outcome: "saved" });
    expect(await save(77, 400)).toEqual({ outcome: "stale" });
    expect(await save(78, 10)).toEqual({ outcome: "saved" });
    expect(await one("select bulk_operation_id::int as op, committed_line::int as line from public.sync_checkpoints where shop_key = $1", [s.key])).toEqual({ op: 78, line: 10 });
  });
});

describe("privileges", () => {
  it("lets only service_role call the write functions", async () => {
    for (const fn of [
      "ingest_catalog(integer, jsonb, jsonb, jsonb)", "ingest_inventory(integer, jsonb, jsonb, bigint[])", "ingest_orders(integer, jsonb, jsonb, jsonb)",
      "ingest_customers(integer, jsonb)", "derive_customer_order_facts(integer, bigint, integer)", "ingest_returns(integer, jsonb, jsonb)",
      "save_sync_checkpoint(integer, text, uuid, bigint, bigint, timestamptz)",
    ]) {
      const row = await one(
        `select has_function_privilege('service_role', $1, 'execute') as service,
                has_function_privilege('anon', $1, 'execute') or has_function_privilege('authenticated', $1, 'execute') as public_exec`, [`public.${fn}`]);
      expect(row, fn).toEqual({ service: true, public_exec: false });
    }
  });
});
