/**
 * Real Postgres tests for returns and restrictions (Phase 3, task 4;
 * migration 0047): order and line restrictions, refund line items read by ID,
 * refund-return links, return declines and processed quantities, return
 * eligibility signals and return evidence from the mirror. Synthetic rows only.
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
  const shop = `r-${tag()}.myshopify.com`;
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
const refund = (id, orderId) => ({ shopify_id: id, order_shopify_id: orderId, shopify_created_at: days(1), processed_at: days(1), total_refunded: "10", currency: "GBP" });
const orders = (s, o, l = [], r = []) => call("ingest_orders", s.key, json(o), json(l), json(r));

describe("returns and restrictions (0047)", () => {
  it("stores order and line restrictions, and a refund's lines once read, keeping them on later order writes", async () => {
    const s = await boundShop();
    await orders(s, [order(s, 1, days(100), { product_network: true, return_status: "returned" })],
      [line(11, 1, 7, 2, { restockable: true, non_fulfillable_quantity: 0, requires_shipping: true, is_gift_card: false })], [refund(21, 1)]);
    expect(await one("select product_network, return_status from public.orders where shop_key = $1", [s.key])).toEqual({ product_network: true, return_status: "returned" });
    expect(await one("select restockable, requires_shipping, is_gift_card from public.order_line_items where shop_key = $1", [s.key]))
      .toEqual({ restockable: true, requires_shipping: true, is_gift_card: false });
    expect((await call("refund_lines_due", s.key, 100)).map(Number)).toEqual([21]);

    const written = await call("ingest_refund_lines", s.key, json([{ shopify_id: 21, return_shopify_id: 31 }, { shopify_id: 99, return_shopify_id: null }]),
      json([{ shopify_id: 41, refund_shopify_id: 21, line_item_shopify_id: 11, quantity: 1, restock_type: "return", subtotal: "10" },
            { shopify_id: 42, refund_shopify_id: 99, line_item_shopify_id: 11, quantity: 1 }]));
    expect(written).toMatchObject({ refunds: 1, skipped: 1, lines: 1 });
    expect(await call("refund_lines_due", s.key, 100)).toEqual([]);
    // The order is written again (a webhook): the refund keeps its lines, read state and return.
    await orders(s, [order(s, 1, days(100), { shopify_updated_at: days(0) })], [line(11, 1, 7, 2)], [refund(21, 1)]);
    expect(await one("select lines_read, return_shopify_id from public.refunds where shop_key = $1", [s.key])).toEqual({ lines_read: true, return_shopify_id: "31" });
    // Lines replaced on a second read.
    await call("ingest_refund_lines", s.key, json([{ shopify_id: 21, return_shopify_id: 31 }]), json([{ shopify_id: 43, refund_shopify_id: 21, line_item_shopify_id: 11, quantity: 2 }]));
    expect(await q("select shopify_id, quantity from public.refund_line_items where shop_key = $1", [s.key])).toEqual([{ shopify_id: "43", quantity: 2 }]);
    await expect(call("ingest_refund_lines", s.key, json([{ shopify_id: 21 }]), json([{ shopify_id: 44, refund_shopify_id: 21, quantity: 1, restock_type: "maybe" }])))
      .rejects.toThrow(/restock_type/);

    // Deleting the order (Shopify deleted it) takes the refund's lines with it.
    await call("delete_synced_records", s.key, "order", [1]);
    expect(Number((await one("select count(*) as n from public.refund_line_items where shop_key = $1", [s.key])).n)).toBe(0);
  });

  it("stores return declines and processed quantities, and links returns to the refunds that settle them", async () => {
    const s = await boundShop();
    await orders(s, [order(s, 1, days(100))], [line(11, 1, 7, 2)], [refund(21, 1)]);
    await call("ingest_returns", s.key,
      json([{ shopify_id: 31, order_shopify_id: 1, status: "closed", fields_version: 2, request_approved_at: days(90) },
            { shopify_id: 32, order_shopify_id: 1, status: "declined", fields_version: 2, decline_reason: "final_sale" }]),
      json([{ shopify_id: 51, return_shopify_id: 31, line_item_shopify_id: 11, quantity: 1, processed_quantity: 1, refunded_quantity: 1, unprocessed_quantity: 0,
              return_reason: "size_too_small", return_reason_name: "Size too small", restocking_fee_amount: "2.50", restocking_fee_percentage: 10 }]),
      json([{ return_shopify_id: 31, refund_shopify_id: 21 }]));
    expect(await one("select return_shopify_id from public.refunds where shop_key = $1", [s.key])).toEqual({ return_shopify_id: "31" });
    expect(await one("select decline_reason from public.returns where shop_key = $1 and shopify_id = 32", [s.key])).toEqual({ decline_reason: "final_sale" });
    expect(await one("select processed_quantity, return_reason_name, restocking_fee_percentage from public.return_line_items where shop_key = $1", [s.key]))
      .toEqual({ processed_quantity: 1, return_reason_name: "Size too small", restocking_fee_percentage: "10" });
    await expect(call("ingest_returns", s.key, json([{ shopify_id: 33, order_shopify_id: 1, status: "open", decline_reason: "changed_mind" }]), "[]", "[]"))
      .rejects.toThrow(/decline_reason/);
  });

  it("gives each product's return signals with their source and trust, and none for a product without any", async () => {
    const s = await boundShop();
    await call("ingest_catalog", s.key, json([
      { shopify_id: 1, title: "Card", status: "active", is_gift_card: true, tags: [], shopify_updated_at: days(1) },
      { shopify_id: 2, title: "Swimsuit", status: "active", tags: ["Summer", "Final Sale"], shopify_updated_at: days(1) },
      { shopify_id: 3, title: "Earrings", status: "active", tags: [], shopify_updated_at: days(1) },
      { shopify_id: 4, title: "Lamp", status: "active", tags: ["home"], shopify_updated_at: days(1) },
      { shopify_id: 5, title: "Mask", status: "active", tags: [], shopify_updated_at: days(1) },
    ]), "[]", json([{ owner_shopify_id: 3, namespace: "custom", key: "final_sale", type: "boolean", value_excerpt: "true" },
                   { owner_shopify_id: 4, namespace: "custom", key: "final_sale", type: "boolean", value_excerpt: "false" }]));
    await orders(s, [order(s, 1, days(100))], [line(11, 1, 5, 1)]);
    await call("ingest_returns", s.key, json([{ shopify_id: 31, order_shopify_id: 1, name: "#1-R1", status: "declined", fields_version: 2, decline_reason: "final_sale" }]),
      json([{ shopify_id: 51, return_shopify_id: 31, line_item_shopify_id: 11, quantity: 1 }]), "[]");
    const signals = await call("product_return_signals", s.key, [1, 2, 3, 4, 5]);
    expect(signals.map((x) => [x.product_id, x.signal, x.trust])).toEqual([
      [1, "gift_card", "verified"], [2, "tag", "unverified"], [3, "metafield", "unverified"], [5, "declined_final_sale", "observed"],
    ]);
    expect(signals.find((x) => x.product_id === 5).detail).toBe("#1-R1");
  });

  it("computes return evidence from the mirror, and withholds what it has not read", async () => {
    const s = await boundShop();
    // Product 7: 40 units over 20 eligible orders, 8 returned (reason: size), 3 refunded.
    const o = [];
    const l = [];
    for (let i = 1; i <= 20; i++) { o.push(order(s, i, days(100 + i))); l.push(line(100 + i, i, 7, 2)); }
    // Outside the window or not eligible: too recent, too old, cancelled, test.
    o.push(order(s, 90, days(30)), order(s, 91, days(400)), order(s, 92, days(100), { cancelled_at: days(99) }), order(s, 93, days(100), { is_test: true }));
    l.push(line(190, 90, 7, 5), line(191, 91, 7, 5), line(192, 92, 7, 5), line(193, 93, 7, 5));
    // Product 8: 10 units, too few for a rate.
    o.push(order(s, 30, days(120))); l.push(line(130, 30, 8, 10));
    await orders(s, o, l, [refund(201, 1), refund(202, 2)]);
    await call("ingest_returns", s.key,
      json([1, 2, 3, 4].map((n) => ({ shopify_id: 300 + n, order_shopify_id: n, status: "closed", fields_version: 2 }))),
      json([1, 2, 3, 4].map((n) => ({ shopify_id: 400 + n, return_shopify_id: 300 + n, line_item_shopify_id: 100 + n, quantity: 2, processed_quantity: 2,
        return_reason_name: n < 4 ? "Size too small" : "Changed mind" }))), "[]");

    const evidence = async () => Object.fromEntries((await call("product_return_evidence", s.key, [7, 8, 9])).map((r) => [r.product_id, r]));
    // One refund's lines unread: refunded units are withheld, never counted as zero.
    await call("ingest_refund_lines", s.key, json([{ shopify_id: 201, return_shopify_id: null }]), json([{ shopify_id: 501, refund_shopify_id: 201, line_item_shopify_id: 101, quantity: 2 }]));
    let rows = await evidence();
    expect(rows[7]).toMatchObject({ eligible_units: 40, processed_return_units: 8, refunded_units: null, processed_return_rate: 0.2,
      primary_reason: "Size too small", risk: "review", complete: false, refunds_unread: 1 });
    expect(rows[8]).toMatchObject({ eligible_units: 10, processed_return_rate: null, risk: "insufficient_data" });
    expect(rows[9]).toBeUndefined();

    await call("ingest_refund_lines", s.key, json([{ shopify_id: 202, return_shopify_id: null }]), json([{ shopify_id: 502, refund_shopify_id: 202, line_item_shopify_id: 102, quantity: 1 }]));
    rows = await evidence();
    expect(rows[7]).toMatchObject({ refunded_units: 3, complete: true });

    // A return stored before Phase 3's fields: processed units unknown, the product's evidence is incomplete.
    await q("update public.returns set fields_version = null where shop_key = $1 and shopify_id = 301", [s.key]);
    expect((await evidence())[7]).toMatchObject({ processed_return_units: null, processed_return_rate: null, risk: "incomplete", complete: false });
  });

  it("deletes a deleted product's variant metafields, and lets only the service role call the new functions", async () => {
    const s = await boundShop();
    await call("ingest_catalog", s.key, json([{ shopify_id: 1, title: "Board", status: "active", tags: [], shopify_updated_at: days(1) }]),
      json([{ shopify_id: 11, product_shopify_id: 1, price: "10", shopify_updated_at: days(1) }]),
      json([{ owner_type: "variant", owner_shopify_id: 11, product_shopify_id: 1, namespace: "specs", key: "length", type: "dimension", value_excerpt: "{}" }]));
    await call("delete_synced_records", s.key, "product", [1]);
    expect(Number((await one("select count(*) as n from public.metafields where shop_key = $1", [s.key])).n)).toBe(0);
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.product_return_evidence($1, '{1}')", [s.key])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select public.refund_lines_due($1, 10)", [s.key])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select * from public.refund_line_items")).rejects.toThrow(/permission denied/);
    }
  });
});
