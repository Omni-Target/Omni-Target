/**
 * Late arrivals in history months (Phase 2; migration 0042). Synthetic rows only, passed as the
 * incremental sync passes the orders it fetched from before the retained window.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

pg.types.setTypeParser(1082, (value) => value);
const pool = new pg.Pool({ connectionString: url, max: 6 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const params = (args) => args.map((a) => (Array.isArray(a) ? JSON.stringify(a) : a));

async function call(fn, ...args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, params(args));
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

let counter = 0;
async function boundShop() {
  const shop = `ha-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}.myshopify.com`;
  const shopify = Math.floor(Math.random() * 9e12) + 1e12;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop') as r", [shopify, shop, `user_${shop}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key };
}
/** A finished import with the orders domain complete; its window is the current one. */
async function finishedImport(s) {
  const { import_id: id } = await call("request_shop_import", s.key);
  await call("claim_shop_import", id, `run_${id}`, 900);
  await call("finish_shop_import", id, `run_${id}`, "succeeded", JSON.stringify({ domains: { orders: { status: "succeeded" } } }), null);
  return id;
}

const KEY = randomBytes(32);
const digest = (s, type, id) => createHmac("sha256", KEY).update(`${s.shopify}:${type}:${id}`).digest("hex");
const windowStart = async () => new Date((await one("select public.retention_window_start() as t")).t);
/** The first day of the month `offset` months from the window start, as a date string. */
const month = (start, offset) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
const day = (monthText, d, hour = 12) => new Date(`${monthText}T00:00:00Z`).getTime() + (d - 1) * 86_400_000 + hour * 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

/** A history month's final summary as the import wrote it, finalised at `finalizedAt`. */
async function summarised(s, monthText, finalizedAt) {
  await q(`insert into public.store_monthly_metrics (shop_key, month, calc_version, currency, orders, units, subtotal, total_discounts, total_tax,
             total_shipping, total_price, total_refunded, customers, new_customers, finalized_at)
           values ($1, $2, 1, 'GBP', 1, 1, 10, 0, 1, 2, 13, 0, 1, 1, $3)`, [s.key, monthText, finalizedAt]);
  await q(`insert into public.product_monthly_metrics (shop_key, product_shopify_id, month, calc_version, currency, orders, units, gross_sales,
             discounts, refunded_units, returned_units, customers, first_time_customers, finalized_at)
           values ($1, 10, $2, 1, 'GBP', 1, 1, 10, 0, 0, 0, 1, 1, $3)`, [s.key, monthText, finalizedAt]);
}

/** An order as the sync passes it: processed in a month, created at `createdMs`, with lines and refunds. */
function order(s, id, processedMs, createdMs, { lines = [], refunds = [], cancelled = false, test = false } = {}) {
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.price, 0);
  const refunded = refunds.reduce((sum, r) => sum + r.amount, 0);
  return {
    order: {
      shopify_id: id, shopify_created_at: iso(createdMs), processed_at: iso(processedMs), cancelled_at: cancelled ? iso(processedMs) : null,
      currency: "GBP", subtotal, total_discounts: 0, total_tax: 1, total_shipping: 2, total_price: subtotal + 3, total_refunded: refunded,
      customer_shopify_id: null, is_test: test, order_digest: digest(s, "order", id), customer_digest: null,
    },
    lines: lines.map((l) => ({
      shopify_id: l.id, order_shopify_id: id, product_shopify_id: l.product, quantity: l.quantity, current_quantity: l.quantity - (l.refunded ?? 0),
      refunded_quantity: l.refunded ?? 0, unit_price: l.price, total_discount: 0,
    })),
    refunds: refunds.map((r) => ({
      shopify_id: r.id, order_shopify_id: id, shopify_created_at: iso(r.created), processed_at: iso(r.created), total_refunded: r.amount,
      currency: "GBP", refund_digest: digest(s, "refund", r.id),
    })),
    refundLines: refunds.flatMap((r) => (r.lines ?? []).map((l) => ({ refund_shopify_id: r.id, product_shopify_id: l.product, quantity: l.quantity }))),
  };
}
const arrive = (s, ...orders) => call("apply_history_arrivals", s.key, orders.map((o) => o.order), orders.flatMap((o) => o.lines),
  orders.flatMap((o) => o.refunds), orders.flatMap((o) => o.refundLines));
const storeAdjustments = (s) => q(`select month::text, reason, orders, units, subtotal::float8 as subtotal, total_price::float8 as total,
    total_refunded::float8 as refunded from public.store_monthly_adjustments where shop_key = $1 order by id`, [s.key]);
const productAdjustments = (s) => q(`select product_shopify_id::int as product, month::text, reason, orders, units, gross_sales::float8 as gross,
    refunded_units from public.product_monthly_adjustments where shop_key = $1 order by id`, [s.key]);

describe("late arrivals in history months (0042)", () => {
  it("records a late order in a summarised history month as a correction, once", async () => {
    const s = await boundShop();
    await finishedImport(s);
    const start = await windowStart();
    const h = month(start, -3);
    await summarised(s, h, iso(Date.now() - 86_400_000));

    const late = order(s, 1, day(h, 5), Date.now(), { lines: [{ id: 11, product: 10, quantity: 2, price: 15 }, { id: 12, product: null, quantity: 1, price: 4 }] });
    expect(await arrive(s, late)).toMatchObject({ history_orders: 1, orders_applied: 1, refunds_applied: 0, store_adjustments: 1, product_adjustments: 1 });
    expect(await storeAdjustments(s)).toEqual([{ month: h, reason: "correction", orders: 1, units: 3, subtotal: 34, total: 37, refunded: 0 }]);
    expect(await productAdjustments(s)).toEqual([{ product: 10, month: h, reason: "correction", orders: 1, units: 2, gross: 30, refunded_units: 0 }]);

    // A webhook, the reconcile and a replay all pass the same order again: counted once.
    expect(await arrive(s, late)).toMatchObject({ orders_applied: 0, refunds_applied: 0 });
    expect(await storeAdjustments(s)).toHaveLength(1);
    const [effective] = await rowsOf("store_months_effective", s.key, h, h);
    expect(effective).toMatchObject({ month: h, orders: 2, units: 4, final: true, adjustments: 1, customers: 1 });
    // The ledger holds digests only.
    expect(await q("select subject, octet_length(digest) as n, month::text from public.history_arrivals where shop_key = $1", [s.key]))
      .toEqual([{ subject: "order", n: 32, month: h }]);
  });

  it("counts an order from before the month closed as summarised, and applies only its refunds created after", async () => {
    const s = await boundShop();
    await finishedImport(s);
    const start = await windowStart();
    const h = month(start, -2);
    const closed = Date.now() - 86_400_000;
    await summarised(s, h, iso(closed));

    const counted = order(s, 2, day(h, 3), day(h, 3), {
      lines: [{ id: 21, product: 10, quantity: 2, price: 10, refunded: 1 }],
      refunds: [
        { id: 31, amount: 2.5, created: closed - 3_600_000, lines: [] },
        { id: 32, amount: 7.5, created: Date.now(), lines: [{ product: 10, quantity: 1 }] },
      ],
    });
    expect(await arrive(s, counted)).toMatchObject({ history_orders: 1, orders_applied: 0, refunds_applied: 1, store_adjustments: 1, product_adjustments: 1 });
    expect(await storeAdjustments(s)).toEqual([{ month: h, reason: "refund", orders: 0, units: 0, subtotal: 0, total: 0, refunded: 7.5 }]);
    expect(await productAdjustments(s)).toEqual([{ product: 10, month: h, reason: "refund", orders: 0, units: 0, gross: 0, refunded_units: 1 }]);
    expect(await arrive(s, counted)).toMatchObject({ orders_applied: 0, refunds_applied: 0 });
    expect(await storeAdjustments(s)).toHaveLength(1);
  });

  it("puts a late order's refunds in its correction, and applies a refund made later on its own", async () => {
    const s = await boundShop();
    await finishedImport(s);
    const start = await windowStart();
    const h = month(start, -4);
    await summarised(s, h, iso(Date.now() - 86_400_000));

    const first = order(s, 3, day(h, 8), Date.now(), {
      lines: [{ id: 41, product: 20, quantity: 3, price: 5, refunded: 1 }],
      refunds: [{ id: 51, amount: 5, created: Date.now(), lines: [{ product: 20, quantity: 1 }] }],
    });
    expect(await arrive(s, first)).toMatchObject({ orders_applied: 1, refunds_applied: 0 });
    expect(await storeAdjustments(s)).toEqual([{ month: h, reason: "correction", orders: 1, units: 3, subtotal: 15, total: 18, refunded: 5 }]);
    expect(await productAdjustments(s)).toEqual([{ product: 20, month: h, reason: "correction", orders: 1, units: 3, gross: 15, refunded_units: 1 }]);

    const later = order(s, 3, day(h, 8), Date.now(), {
      lines: [{ id: 41, product: 20, quantity: 3, price: 5, refunded: 2 }],
      refunds: [
        { id: 51, amount: 5, created: Date.now(), lines: [{ product: 20, quantity: 1 }] },
        { id: 52, amount: 4, created: Date.now() + 1000, lines: [{ product: 20, quantity: 1 }] },
      ],
    });
    expect(await arrive(s, later)).toMatchObject({ orders_applied: 0, refunds_applied: 1 });
    expect((await storeAdjustments(s)).slice(1)).toEqual([{ month: h, reason: "refund", orders: 0, units: 0, subtotal: 0, total: 0, refunded: 4 }]);
    expect((await productAdjustments(s)).slice(1)).toEqual([{ product: 20, month: h, reason: "refund", orders: 0, units: 0, gross: 0, refunded_units: 1 }]);
  });

  it("counts every order in a history month the import found empty, and shows the month", async () => {
    const s = await boundShop();
    await finishedImport(s);
    const start = await windowStart();
    const empty = month(start, -5);
    const old = order(s, 4, day(empty, 2), day(empty, 2), { lines: [{ id: 61, product: 30, quantity: 1, price: 9 }] });
    expect(await arrive(s, old)).toMatchObject({ orders_applied: 1 });
    const [effective] = await rowsOf("store_months_effective", s.key, empty, empty);
    expect(effective).toMatchObject({ month: empty, currency: "GBP", orders: 1, units: 1, final: true, adjustments: 1, customers: 0 });
    const products = await rowsOf("product_months_effective", s.key, empty, empty);
    expect(products).toMatchObject([{ month: empty, product_shopify_id: "30", orders: 1, units: 1, final: true }]);
  });

  it("counts a month that left the window from the day it left", async () => {
    const s = await boundShop();
    const importId = await finishedImport(s);
    // The shop was imported when this month was still inside the window.
    await q("update public.shop_imports set window_start = '2000-01-01' where id = $1", [importId]);
    const start = await windowStart();
    const left = month(start, -1);
    const leftAt = new Date(`${left}T00:00:00Z`);
    leftAt.setUTCMonth(leftAt.getUTCMonth() + 25);
    await summarised(s, left, iso(day(left, 1) + 120 * 86_400_000));

    const before = order(s, 5, day(left, 10), leftAt.getTime() - 3_600_000, { lines: [{ id: 71, product: 10, quantity: 1, price: 10 }] });
    const after = order(s, 6, day(left, 10), Math.max(leftAt.getTime() + 1000, Date.now() - 1000), { lines: [{ id: 72, product: 10, quantity: 1, price: 10 }] });
    expect(await arrive(s, before, after)).toMatchObject({ history_orders: 2, orders_applied: 1 });
    expect(await storeAdjustments(s)).toEqual([{ month: left, reason: "correction", orders: 1, units: 1, subtotal: 10, total: 13, refunded: 0 }]);
  });

  it("ignores test, cancelled and in-window orders", async () => {
    const s = await boundShop();
    await finishedImport(s);
    const start = await windowStart();
    const h = month(start, -3);
    const recent = month(start, 2);
    const result = await arrive(s,
      order(s, 7, day(h, 1), Date.now(), { test: true, lines: [{ id: 81, product: 10, quantity: 1, price: 1 }] }),
      order(s, 8, day(h, 1), Date.now(), { cancelled: true, lines: [{ id: 82, product: 10, quantity: 1, price: 1 }] }),
      order(s, 9, day(recent, 1), Date.now(), { lines: [{ id: 83, product: 10, quantity: 1, price: 1 }] }));
    expect(result).toMatchObject({ history_orders: 2, orders_applied: 0, refunds_applied: 0 });
    expect(await storeAdjustments(s)).toEqual([]);
    expect(await arrive(s, order(s, 10, day(recent, 1), Date.now()))).toEqual({ history_orders: 0 });
  });

  it("waits while an import is in progress, and does nothing before a complete orders import", async () => {
    const s = await boundShop();
    const start = await windowStart();
    const h = month(start, -3);
    const late = order(s, 11, day(h, 1), Date.now(), { lines: [{ id: 91, product: 10, quantity: 1, price: 1 }] });
    expect(await arrive(s, late)).toMatchObject({ history_orders: 1, skipped: "not_imported" });

    await finishedImport(s);
    await call("request_shop_import", s.key);
    expect(await arrive(s, late)).toMatchObject({ history_orders: 1, deferred: true });
    expect(await storeAdjustments(s)).toEqual([]);
    expect(await one("select count(*)::int as n from public.history_arrivals where shop_key = $1", [s.key])).toEqual({ n: 0 });
  });

  it("keeps the summary of a month with adjustments when an import summarises history again", async () => {
    const s = await boundShop();
    await finishedImport(s);
    const start = await windowStart();
    const empty = month(start, -6);
    const late = order(s, 12, day(empty, 4), Date.now(), { lines: [{ id: 101, product: 40, quantity: 2, price: 3 }] });
    expect(await arrive(s, late)).toMatchObject({ orders_applied: 1 });

    // A re-import exports the same order and summarises the month: the late order is not counted twice.
    const { import_id: again } = await call("request_shop_import", s.key);
    await call("claim_shop_import", again, "run_again", 900);
    await call("stage_history_orders", again, "run_again", [late.order], late.lines);
    expect(await call("summarise_history_month", again, "run_again", empty, 1)).toMatchObject({ store_months: 0, product_months: 0, kept: true });
    expect(await one("select count(*)::int as n from public.store_monthly_metrics where shop_key = $1 and month = $2", [s.key, empty])).toEqual({ n: 0 });
    const [effective] = await rowsOf("store_months_effective", s.key, empty, empty);
    expect(effective).toMatchObject({ orders: 1, units: 2 });
  });

  it("is deleted with the shop's mirrored data", async () => {
    const s = await boundShop();
    await finishedImport(s);
    const start = await windowStart();
    await arrive(s, order(s, 13, day(month(start, -7), 1), Date.now(), { lines: [{ id: 111, product: 10, quantity: 1, price: 1 }] }));
    expect(await one("select count(*)::int as n from public.history_arrivals where shop_key = $1", [s.key])).toEqual({ n: 1 });
    await q("select public.delete_shop_synced_data($1)", [s.shop]);
    expect(await one("select count(*)::int as n from public.history_arrivals where shop_key = $1", [s.key])).toEqual({ n: 0 });
    expect(await one("select public.shop_synced_row_count($1)::int as n", [s.shop])).toEqual({ n: 0 });
  });
});
