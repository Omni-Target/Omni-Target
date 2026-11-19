/**
 * Summary maintenance (Phase 2, task 8; decision 6; migration 0036).
 * Synthetic rows only, written through the ingestion RPCs as an import or a
 * webhook would write them.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

// Months are calendar dates: read them as 'YYYY-MM-DD', not as local-time Date objects.
pg.types.setTypeParser(1082, (value) => value);
const pool = new pg.Pool({ connectionString: url, max: 6 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const params = (args) => args.map((a) => (Array.isArray(a) ? JSON.stringify(a) : a));

/** An RPC as the app calls it: service_role, with array arguments sent as JSON. */
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

/** The rows of a set-returning RPC, as service_role. */
async function rowsOf(fn, ...args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(`select * from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

let counter = 0;
async function boundShop() {
  const shop = `sm-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}.myshopify.com`;
  const shopify = Math.floor(Math.random() * 9e12) + 1e12;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop') as r", [shopify, shop, `user_${shop}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key };
}
/** A finished import, as the workflow records one, with the orders domain's status. */
async function finishedImport(s, ordersStatus = "succeeded") {
  const { import_id: id } = await call("request_shop_import", s.key);
  await call("claim_shop_import", id, `run_${id}`, 900);
  await call("finish_shop_import", id, `run_${id}`, ordersStatus === "succeeded" ? "succeeded" : "partial",
    JSON.stringify({ domains: { orders: { status: ordersStatus } } }), null);
  return id;
}

/** A final month (six months ago, past the 120 days) and the open current month. */
const months = () => one(`select date_trunc('month', now() - interval '6 months')::date::text as final,
                                 date_trunc('month', now())::date::text as open`);
let version = 0;
/** An order and its lines as the workflow maps them; each write is a newer Shopify version. */
function order(id, month, day, { customer = null, lines, refunded = 0, cancelled = false }) {
  version += 1;
  const at = new Date(new Date(`${month}T12:00:00Z`).getTime() + (day - 1) * 86_400_000).toISOString();
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.price, 0);
  return {
    order: {
      shopify_id: id, shopify_created_at: at, processed_at: at, cancelled_at: cancelled ? at : null, currency: "GBP",
      subtotal, total_discounts: 0, total_tax: 2, total_shipping: 3, total_price: subtotal + 5, total_refunded: refunded,
      customer_shopify_id: customer, is_test: false, shopify_updated_at: new Date(Date.UTC(2026, 0, 1) + version * 1000).toISOString(),
    },
    lines: lines.map((l) => ({
      shopify_id: l.id, order_shopify_id: id, product_shopify_id: l.product, quantity: l.quantity, unit_price: l.price,
      total_discount: 0, refunded_quantity: l.refunded ?? 0, current_quantity: l.quantity - (l.refunded ?? 0),
    })),
  };
}
const ingest = (s, ...orders) => call("ingest_orders", s.key, orders.map((o) => o.order), orders.flatMap((o) => o.lines), []);
const lateRefund = (m) => order(1, m.final, 3, {
  customer: 501, refunded: 10, lines: [{ id: 11, product: 10, quantity: 2, price: 10, refunded: 1 }, { id: 12, product: 20, quantity: 1, price: 30 }],
});
const dirty = async (s) => (await q("select month::text from public.summary_dirty_months where shop_key = $1 order by month", [s.key])).map((r) => r.month);
const productAdjustments = (s) =>
  q(`select product_shopify_id::int as product, month::text, reason, orders, units, gross_sales::float8 as gross, refunded_units, returned_units
       from public.product_monthly_adjustments where shop_key = $1 order by id`, [s.key]);
const storeAdjustments = (s) =>
  q(`select month::text, reason, orders, units, subtotal::float8 as subtotal, total_tax::float8 as tax, total_shipping::float8 as shipping,
            total_price::float8 as total, total_refunded::float8 as refunded
       from public.store_monthly_adjustments where shop_key = $1 order by id`, [s.key]);
const finalRows = (s, month) =>
  q(`select 'product' as kind, product_shopify_id::int as product, computed_at, finalized_at, orders, units, gross_sales::text as amount
       from public.product_monthly_metrics where shop_key = $1 and month = $2
     union all
     select 'store', null, computed_at, finalized_at, orders, units, total_price::text
       from public.store_monthly_metrics where shop_key = $1 and month = $2 order by 1, 2`, [s.key, month]);

/** Three orders in the final month (customers 501 twice, 502 once) and one in the open month. */
async function seededShop() {
  const s = await boundShop();
  const m = await months();
  await ingest(s,
    order(1, m.final, 3, { customer: 501, lines: [{ id: 11, product: 10, quantity: 2, price: 10 }, { id: 12, product: 20, quantity: 1, price: 30 }] }),
    order(2, m.final, 9, { customer: 502, lines: [{ id: 21, product: 10, quantity: 1, price: 10 }] }),
    order(3, m.final, 15, { customer: 501, lines: [{ id: 31, product: 20, quantity: 1, price: 30 }] }),
    order(4, m.open, 1, { customer: 503, lines: [{ id: 41, product: 10, quantity: 1, price: 10 }] }));
  await finishedImport(s);
  return { s, m };
}
/** The measured fields: everything but customer counts and bookkeeping. */
const measured = ({ month, customers, first_time_customers, new_customers, final, adjustments, ...rest }) => rest;

describe("summary maintenance (task 8)", () => {
  it("records late refunds, returns and corrections to a final month as adjustments, and keeps effective totals equal to a recomputation", async () => {
    const { s, m } = await seededShop();
    expect(await dirty(s)).toEqual([m.final, m.open]);
    expect(await call("refresh_summary_month", s.key, m.final, 1)).toMatchObject({ state: "finalised", product_months: 2, store_months: 1 });
    expect(await call("refresh_summary_month", s.key, m.open, 1)).toMatchObject({ state: "open", product_months: 1, store_months: 1 });
    expect(await dirty(s)).toEqual([]);
    const finalBefore = await finalRows(s, m.final);
    expect(finalBefore.every((row) => row.finalized_at !== null)).toBe(true);

    // A late refund: one unit of product 10 on order 1, 10.00 back.
    await ingest(s, lateRefund(m));
    expect(await rowsOf("summary_months_due", 5000)).toEqual(expect.arrayContaining([{ shop_key: s.key, shop_domain: s.shop, month: m.final, reason: "changed" }]));
    expect(await call("maintain_summary_month", s.key, m.final, 1)).toMatchObject({ state: "adjusted", product_adjustments: 1, store_adjustments: 1 });

    // A late return of order 2's line.
    await call("ingest_returns", s.key,
      [{ shopify_id: 70, order_shopify_id: 2, status: "closed", total_quantity: 1, shopify_created_at: new Date().toISOString() }],
      [{ shopify_id: 71, return_shopify_id: 70, line_item_shopify_id: 21, quantity: 1, return_reason: "defective" }]);
    expect(await dirty(s)).toEqual([m.final]);
    expect(await call("maintain_summary_month", s.key, m.final, 1)).toMatchObject({ state: "adjusted", product_adjustments: 1, store_adjustments: 0 });

    // A correction: order 2 cancelled late.
    await ingest(s, order(2, m.final, 9, { customer: 502, cancelled: true, lines: [{ id: 21, product: 10, quantity: 1, price: 10 }] }));
    expect(await call("maintain_summary_month", s.key, m.final, 1)).toMatchObject({ state: "adjusted", product_adjustments: 1, store_adjustments: 1 });
    // Nothing new: nothing recorded.
    expect(await call("maintain_summary_month", s.key, m.final, 1)).toMatchObject({ state: "unchanged", product_adjustments: 0, store_adjustments: 0 });

    expect(await productAdjustments(s)).toEqual([
      { product: 10, month: m.final, reason: "refund", orders: 0, units: 0, gross: 0, refunded_units: 1, returned_units: 0 },
      { product: 10, month: m.final, reason: "return", orders: 0, units: 0, gross: 0, refunded_units: 0, returned_units: 1 },
      // The cancelled order's sale and its return both leave the month.
      { product: 10, month: m.final, reason: "correction", orders: -1, units: -1, gross: -10, refunded_units: 0, returned_units: -1 },
    ]);
    expect(await storeAdjustments(s)).toEqual([
      { month: m.final, reason: "refund", orders: 0, units: 0, subtotal: 0, tax: 0, shipping: 0, total: 0, refunded: 10 },
      { month: m.final, reason: "correction", orders: -1, units: -1, subtotal: -10, tax: -2, shipping: -3, total: -15, refunded: 0 },
    ]);

    // The final summary never changed; final plus adjustments equals the month recomputed from detail.
    expect(await finalRows(s, m.final)).toEqual(finalBefore);
    const effectiveProducts = await q("select * from public.product_months_effective($1, $2, $2)", [s.key, m.final]);
    const recomputedProducts = await q("select * from public.detail_product_month($1, $2) order by product_shopify_id", [s.key, m.final]);
    expect(effectiveProducts.map(measured)).toEqual(recomputedProducts.map(measured));
    expect(effectiveProducts.map((row) => [row.final, row.adjustments])).toEqual([[true, 3], [true, 0]]);
    const [effectiveStore] = await q("select * from public.store_months_effective($1, $2, $2)", [s.key, m.final]);
    const [recomputedStore] = await q("select * from public.detail_store_month($1, $2)", [s.key, m.final]);
    expect(measured(effectiveStore)).toEqual(measured(recomputedStore));
    // Customer counts stay as finalised: 502 left the month with the cancellation, but the count is not adjusted.
    expect(effectiveStore).toMatchObject({ customers: 2, final: true, adjustments: 2 });
    expect(recomputedStore.customers).toBe(1);
  });

  it("rebuilds an open month without adjustments and refreshes exactly the month asked for", async () => {
    const { s, m } = await seededShop();
    await call("refresh_summary_month", s.key, m.final, 1);
    await call("refresh_summary_month", s.key, m.open, 1);
    const finalStamp = await one("select computed_at from public.store_monthly_metrics where shop_key = $1 and month = $2", [s.key, m.final]);

    await ingest(s, order(4, m.open, 1, { customer: 503, lines: [{ id: 41, product: 10, quantity: 3, price: 10 }] }));
    expect(await call("maintain_summary_month", s.key, m.open, 1)).toMatchObject({ month: m.open, state: "open", product_adjustments: 0, store_adjustments: 0 });
    expect(await one("select units, finalized_at from public.store_monthly_metrics where shop_key = $1 and month = $2", [s.key, m.open])).toEqual({ units: 3, finalized_at: null });
    expect(await one("select computed_at from public.store_monthly_metrics where shop_key = $1 and month = $2", [s.key, m.final])).toEqual(finalStamp);
    expect(await one("select count(*)::int as n from public.store_monthly_adjustments where shop_key = $1", [s.key])).toEqual({ n: 0 });
  });

  it("refuses any change to a final summary or an adjustment", async () => {
    const { s, m } = await seededShop();
    await call("refresh_summary_month", s.key, m.final, 1);
    await expect(q("update public.store_monthly_metrics set orders = orders + 1 where shop_key = $1 and month = $2", [s.key, m.final])).rejects.toThrow(/summary_final/);
    await expect(q("update public.product_monthly_metrics set units = 0 where shop_key = $1 and month = $2", [s.key, m.final])).rejects.toThrow(/summary_final/);
    await ingest(s, lateRefund(m));
    await call("maintain_summary_month", s.key, m.final, 1);
    await expect(q("update public.store_monthly_adjustments set total_refunded = 0 where shop_key = $1", [s.key])).rejects.toThrow(/summary_final/);
  });

  it("leaves final months as they are when their detail is gone, and history months before the window", async () => {
    const { s, m } = await seededShop();
    await call("refresh_summary_month", s.key, m.final, 1);
    const before = await finalRows(s, m.final);
    // What pruning would do to the month's detail: no negative adjustments follow.
    await q("delete from public.orders where shop_key = $1 and processed_at >= $2::date and processed_at < $2::date + interval '1 month'", [s.key, m.final]);
    expect(await dirty(s)).toContain(m.final);
    expect(await call("maintain_summary_month", s.key, m.final, 1)).toMatchObject({ state: "frozen", product_adjustments: 0, store_adjustments: 0 });
    expect(await finalRows(s, m.final)).toEqual(before);

    // A history month (summarised by an import, no detail) before the window.
    const { history } = await one("select (public.retention_window_start() - interval '3 months')::date::text as history");
    await q("insert into public.store_monthly_metrics (shop_key, month, calc_version, currency, orders, total_price, finalized_at) values ($1, $2, 1, 'GBP', 4, 100, now())", [s.key, history]);
    expect(await call("maintain_summary_month", s.key, history, 1)).toMatchObject({ state: "frozen" });
    expect(await one("select orders, total_price::float8 as total from public.store_monthly_metrics where shop_key = $1 and month = $2", [s.key, history])).toEqual({ orders: 4, total: 100 });
  });

  it("lists due months only for shops ready for maintenance, changed months first", async () => {
    const { s, m } = await seededShop();
    const due = (await rowsOf("summary_months_due", 5000)).filter((row) => row.shop_key === s.key);
    // Both seeded months changed; then every other month that can still change (485 days, 17 months in all).
    expect(due.slice(0, 2)).toEqual([
      { shop_key: s.key, shop_domain: s.shop, month: m.final, reason: "changed" },
      { shop_key: s.key, shop_domain: s.shop, month: m.open, reason: "changed" },
    ]);
    expect(due.slice(2).every((row) => row.reason === "open")).toBe(true);
    expect(new Set(due.map((row) => row.month)).size).toBe(due.length);
    expect(due.length).toBe(Number((await one(
      "select count(*) as n from generate_series(date_trunc('month', now() - interval '485 days'), date_trunc('month', now()), interval '1 month')")).n));

    // An import in progress: nothing listed, and a month listed earlier is not refreshed.
    const { import_id: running } = await call("request_shop_import", s.key);
    expect((await rowsOf("summary_months_due", 5000)).some((row) => row.shop_key === s.key)).toBe(false);
    expect(await call("maintain_summary_month", s.key, m.final, 1)).toEqual({ month: m.final, state: "not_ready" });
    await call("finish_shop_import", running, null, "cancelled", null, "test");

    // Orders never fully imported: not ready either.
    const partial = await boundShop();
    await ingest(partial, order(9, m.open, 2, { lines: [{ id: 91, product: 10, quantity: 1, price: 10 }] }));
    await finishedImport(partial, "failed");
    expect((await rowsOf("summary_months_due", 5000)).some((row) => row.shop_key === partial.key)).toBe(false);

    // A shop being uninstalled: the refresh refuses it.
    await call("begin_uninstall", s.shopify, s.shop, randomUUID(), (await one("select clock_timestamp()::text as t")).t);
    await expect(call("maintain_summary_month", s.key, m.final, 1)).rejects.toThrow(/shop_not_ingestible/);
  });

  it("marks nothing when a customer is redacted, and records a late change once when two refreshes race", async () => {
    const { s, m } = await seededShop();
    await call("refresh_summary_month", s.key, m.final, 1);
    // customers/redact clears customer 502 from order 2; no measured field changes.
    await call("record_customer_compliance", "customers/redact", s.shopify, s.shop, randomUUID(), new Date(), 502, "{2}", null, null, 1);
    expect(await one("select customer_shopify_id from public.orders where shop_key = $1 and shopify_id = 2", [s.key])).toEqual({ customer_shopify_id: null });
    expect(await dirty(s)).toEqual([m.open]);

    await ingest(s, lateRefund(m));
    // No changed-month mark to contend on (as for a month listed as open): only the month lock orders two refreshes.
    await q("delete from public.summary_dirty_months where shop_key = $1", [s.key]);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("begin");
      await first.query("set local role service_role");
      expect((await first.query("select public.maintain_summary_month($1, $2, 1) as r", [s.key, m.final])).rows[0].r).toMatchObject({ state: "adjusted" });
      await second.query("begin");
      await second.query("set local role service_role");
      await second.query("set local lock_timeout = '300ms'");
      await expect(second.query("select public.maintain_summary_month($1, $2, 1) as r", [s.key, m.final])).rejects.toThrow(/lock timeout/);
      await second.query("rollback");
      await first.query("commit");
    } finally {
      first.release();
      second.release();
    }
    expect(await call("maintain_summary_month", s.key, m.final, 1)).toMatchObject({ state: "unchanged" });
    expect(await one(`select (select count(*) from public.product_monthly_adjustments where shop_key = $1)::int as product,
                             (select count(*) from public.store_monthly_adjustments where shop_key = $1)::int as store`, [s.key]))
      .toEqual({ product: 1, store: 1 });
  });

  it("lets service_role run the maintenance functions and nothing internal", async () => {
    for (const [fn, service] of [
      ["refresh_summary_month(integer, date, integer)", true],
      ["maintain_summary_month(integer, date, integer)", true],
      ["summary_months_due(integer)", true],
      ["product_months_effective(integer, date, date, integer)", true],
      ["store_months_effective(integer, date, date, integer)", true],
      ["summarise_detail_month(integer, date, integer)", false],
      ["detail_product_month(integer, date)", false],
      ["detail_store_month(integer, date)", false],
      ["summary_maintenance_ready(integer)", false],
    ]) {
      expect(await one(
        `select has_function_privilege('service_role', $1, 'execute') as service,
                has_function_privilege('anon', $1, 'execute') or has_function_privilege('authenticated', $1, 'execute') as public_exec`, [`public.${fn}`]), fn)
        .toEqual({ service, public_exec: false });
    }
  });
});
