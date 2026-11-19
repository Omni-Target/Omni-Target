/**
 * History beyond the retained window (Phase 2, task 7; decision 3;
 * migrations 0030, 0034 and 0035). Synthetic rows only.
 *
 * One synthetic order history goes through two paths:
 *  A. full detail: every order canonical, summarised by refresh_monthly_aggregates;
 *  B. the import: window orders through ingest_orders, older orders staged in
 *     batches (one replayed, as a retry would), summarised month by month and
 *     discarded, while another shop's import stages a conflicting history.
 * Both must give identical monthly product and store summaries, first orders
 * and window cohorts. B must keep no detailed order older than the window,
 * and its staging must end empty.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 6 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const params = (args) => args.map((a) => (Array.isArray(a) ? JSON.stringify(a) : a));
const rpcSql = (fn, args) => `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`;

/** An RPC as the app calls it: service_role, with array arguments sent as JSON. */
async function call(fn, ...args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(rpcSql(fn, args), params(args));
    await client.query("commit");
    return rows[0].result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

let counter = 0;
async function boundShop() {
  const shop = `hist-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}.myshopify.com`;
  const shopify = Math.floor(Math.random() * 9e12) + 1e12;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop') as r", [shopify, shop, `user_hist_${shop}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key };
}
async function claimedImport(s, runId) {
  const { import_id: id } = await call("request_shop_import", s.key);
  const claim = await call("claim_shop_import", id, runId, 900);
  expect(claim).toMatchObject({ outcome: "claimed" });
  return { id, claim };
}
const KEY = randomBytes(32);
const digest = (shopify, type, id) => createHmac("sha256", KEY).update(`${shopify}:${type}:${id}`).digest("hex");
const windowStart = async () => new Date((await one("select public.retention_window_start() as t")).t);
const monthOf = (start, offset) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
const isoMonth = (start, offset) => monthOf(start, offset).toISOString().slice(0, 10);
const at = (start, offset, day) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, day, 12)).toISOString();

/** Orders and lines as the workflow maps them (customer IDs and keyed digests). */
const mapOrder = (s, o) => ({
  shopify_id: o.id, shopify_created_at: o.at, processed_at: o.at, cancelled_at: o.cancelled ? o.at : null, currency: "GBP",
  subtotal: o.subtotal, total_discounts: o.discounts, total_tax: o.tax, total_shipping: o.shipping, total_price: o.total,
  total_refunded: o.refunded, customer_shopify_id: o.customer, is_test: o.test,
  customer_digest: o.customer ? digest(s.shopify, "customer", o.customer) : null, order_digest: digest(s.shopify, "order", o.id),
});
const mapLine = (l) => ({
  shopify_id: l.id, order_shopify_id: l.order, product_shopify_id: l.product, quantity: l.quantity, unit_price: l.price,
  total_discount: l.discount, refunded_quantity: l.refunded,
});

/**
 * Six whole months before the window (repeat and first-time customers, guest
 * orders, discounts, refunds, a test order, a cancelled order, a line with no
 * product) and two months inside it, where customers 501 and 503 return and
 * 505 is new.
 */
function syntheticHistory(start) {
  const orders = [];
  const lines = [];
  const buyers = [501, 502, 503, 504, null];
  let lineId = 1000;
  const addLines = (orderId, k, products) => {
    for (const product of products) {
      lineId += 1;
      lines.push({ id: lineId, order: orderId, product, quantity: 1 + (k % 3), price: 10 + (product ?? 0) / 10, discount: k % 2 ? 0.5 : 0, refunded: k === 3 && product === 10 ? 1 : 0 });
    }
  };
  let orderId = 100;
  for (let m = -6; m <= -1; m++) {
    for (let k = 0; k < 4; k++) {
      orderId += 1;
      orders.push({
        id: orderId, at: at(start, m, 3 + k * 5), customer: buyers[(-m + k) % buyers.length], test: m === -3 && k === 0, cancelled: m === -2 && k === 1,
        subtotal: 20 + k, discounts: k % 2, tax: 2, shipping: 4, total: 26 + k, refunded: k === 3 ? 5 : 0,
      });
      addLines(orderId, k, [10, 20 + (k % 2), m === -4 && k === 2 ? null : 30]);
    }
  }
  const recent = [[0, 4, 501], [0, 9, 505], [0, 14, null], [1, 2, 505], [1, 6, 503]];
  recent.forEach(([m, day, customer], k) => {
    const id = 201 + k;
    orders.push({ id, at: at(start, m, day), customer, test: false, cancelled: false, subtotal: 30, discounts: 1, tax: 3, shipping: 5, total: 37, refunded: k === 4 ? 10 : 0 });
    addLines(id, k, [10, 30]);
  });
  return { orders, lines, history: orders.filter((o) => o.id < 200), recent: orders.filter((o) => o.id > 200) };
}

const productSummaries = (key) =>
  q(`select month::text, product_shopify_id::int as product, currency, orders, units, gross_sales::float8 as gross, discounts::float8 as discounts,
            refunded_units, returned_units, customers, first_time_customers, finalized_at is not null as final
       from public.product_monthly_metrics where shop_key = $1 order by month, product`, [key]);
const storeSummaries = (key) =>
  q(`select month::text, currency, orders, units, subtotal::float8 as subtotal, total_discounts::float8 as discounts, total_tax::float8 as tax,
            total_shipping::float8 as shipping, total_price::float8 as total, total_refunded::float8 as refunded, customers, new_customers,
            finalized_at is not null as final
       from public.store_monthly_metrics where shop_key = $1 order by month`, [key]);
const windowCohorts = (key, start) =>
  q(`select cohort_month::text, currency, first_time_customers, repeat_30d, repeat_60d, repeat_90d, repeat_180d, repeat_365d,
            first_order_revenue::float8 as first_revenue, revenue_60d::float8 as revenue_60d, finalized_at is not null as final
       from public.cohort_monthly_outcomes where shop_key = $1 and cohort_month >= $2 order by cohort_month`, [key, start]);
const firstOrders = (key) =>
  q("select shopify_id::int as customer, first_order_at from public.customers where shop_key = $1 order by shopify_id", [key]);
const addCustomers = (key, ids) => q("insert into public.customers (shop_key, shopify_id) select $1, unnest($2::bigint[])", [key, ids]);
const staged = (importId) =>
  one(`select (select count(*) from public.history_stage_orders where import_id = $1)::int as orders,
              (select count(*) from public.history_stage_lines where import_id = $1)::int as lines`, [importId]);
async function deriveFacts(key) {
  for (let after = 0; after !== null; ) after = (await call("derive_customer_order_facts", key, after, 2000)).next_after;
}

describe("history beyond the window (task 7)", () => {
  it("gives the same summaries, first orders and window cohorts as full detail, keeps no old detail, and leaves no staging", async () => {
    const start = await windowStart();
    const { orders, lines, history, recent } = syntheticHistory(start);
    const customers = [501, 502, 503, 504, 505];
    const [a, b, c] = [await boundShop(), await boundShop(), await boundShop()];

    // A: every order as canonical detail, written directly (ingest_orders refuses orders older than the window).
    for (const o of orders) {
      await q(`insert into public.orders (shop_key, shopify_id, shopify_created_at, processed_at, cancelled_at, currency, subtotal, total_discounts,
                 total_tax, total_shipping, total_price, total_refunded, customer_shopify_id, is_test)
               values ($1, $2, $3, $3, case when $4 then $3::timestamptz end, 'GBP', $5, $6, $7, $8, $9, $10, $11, $12)`,
        [a.key, o.id, o.at, o.cancelled, o.subtotal, o.discounts, o.tax, o.shipping, o.total, o.refunded, o.customer, o.test]);
    }
    for (const l of lines) {
      await q(`insert into public.order_line_items (shop_key, shopify_id, order_shopify_id, product_shopify_id, quantity, unit_price, total_discount, refunded_quantity)
               values ($1, $2, $3, $4, $5, $6, $7, $8)`, [a.key, l.id, l.order, l.product, l.quantity, l.price, l.discount, l.refunded]);
    }
    await addCustomers(a.key, customers);
    await deriveFacts(a.key);
    await call("refresh_monthly_aggregates", a.key, isoMonth(start, -6), isoMonth(start, 1), 1);

    // B: the import. Customers first (as the workflow does), then every order through the window path.
    await addCustomers(b.key, customers);
    const { id: importB, claim } = await claimedImport(b, "run_b");
    expect(new Date(claim.window_start)).toEqual(start);
    const mapped = orders.map((o) => mapOrder(b, o));
    expect(await call("ingest_orders", b.key, mapped, lines.map(mapLine), []))
      .toMatchObject({ orders: recent.length, beyond_window: history.length, line_items: recent.length * 2 });

    // Another shop's import stages a different history under the same order IDs at the same time.
    const { id: importC } = await claimedImport(c, "run_c");
    const otherHistory = history.map((o) => ({ ...mapOrder(c, o), total_price: o.total + 100 }));
    await call("stage_history_orders", importC, "run_c", otherHistory, lines.filter((l) => l.order < 200).map(mapLine));
    const stagedC = await staged(importC);

    // B's history in three batches, the first replayed as a retried batch would be.
    const historyOrders = mapped.filter((o) => o.shopify_id < 200);
    const batches = [historyOrders.slice(0, 9), historyOrders.slice(9, 17), historyOrders.slice(17)];
    const linesOf = (batch) => lines.filter((l) => batch.some((o) => o.shopify_id === l.order)).map(mapLine);
    const total = { orders: 0, lines: 0, customers: 0 };
    for (const batch of [...batches, batches[0]]) {
      const result = await call("stage_history_orders", importB, "run_b", batch, linesOf(batch));
      expect(result).toMatchObject({ in_window: 0, suppressed: 0 });
      for (const k of Object.keys(total)) total[k] += result[k];
    }
    expect(total).toEqual({ orders: history.length, lines: lines.filter((l) => l.order < 200).length, customers: 4 });

    const months = await q("select month::text from public.history_stage_months($1)", [importB]);
    expect(months.map((m) => m.month)).toEqual([-6, -5, -4, -3, -2, -1].map((m) => isoMonth(start, m)));
    for (const { month } of months) await call("summarise_history_month", importB, "run_b", month, 1);
    for (let remaining = 1; remaining > 0; ) remaining = (await call("discard_history_stage", importB, "run_b", 25)).remaining;
    await deriveFacts(b.key);
    for (const m of [0, 1]) await call("refresh_monthly_aggregates", b.key, isoMonth(start, m), isoMonth(start, m), 1);

    const [productsA, storesA] = [await productSummaries(a.key), await storeSummaries(a.key)];
    expect(storesA).toHaveLength(8);
    expect(productsA).toHaveLength(6 * 4 + 2 * 2);
    expect(productsA.every((row) => row.final)).toBe(true);
    expect(await productSummaries(b.key)).toEqual(productsA);
    expect(await storeSummaries(b.key)).toEqual(storesA);
    // Returning customers 501 and 503 are not new inside the window; only 505 is.
    expect(storesA.slice(6).map((row) => row.new_customers)).toEqual([1, 0]);
    expect(await windowCohorts(b.key, isoMonth(start, 0))).toEqual(await windowCohorts(a.key, isoMonth(start, 0)));
    expect((await windowCohorts(a.key, isoMonth(start, 0))).map((row) => row.first_time_customers)).toEqual([1]);
    expect(await firstOrders(b.key)).toEqual(await firstOrders(a.key));

    // B holds detail only from the window's start, and nothing staged; C's staging was untouched.
    expect(await one(`select count(*)::int as orders, count(*) filter (where processed_at < $2)::int as older
                        from public.orders where shop_key = $1`, [b.key, start])).toEqual({ orders: recent.length, older: 0 });
    expect(await staged(importB)).toEqual({ orders: 0, lines: 0 });
    expect(await staged(importC)).toEqual(stagedC);
    for (let remaining = 1; remaining > 0; ) remaining = (await call("discard_history_stage", importC, "run_c", 20_000)).remaining;
  });

  it("pins the window at the first claim, so an import running into a new month splits orders as its queries did", async () => {
    const s = await boundShop();
    const start = await windowStart();
    const { id } = await claimedImport(s, "run_p");
    // The import was claimed a month ago; the window has since moved on by one month.
    await q("update public.shop_imports set window_start = window_start - interval '1 month' where id = $1", [id]);
    const pinned = monthOf(start, -1);
    const order = (orderId, when) => mapOrder(s, { id: orderId, at: when, customer: null, test: false, cancelled: false, subtotal: 10, discounts: 0, tax: 0, shipping: 0, total: 10, refunded: 0 });
    const lineFor = (orderId) => mapLine({ id: orderId * 10, order: orderId, product: 7, quantity: 1, price: 10, discount: 0, refunded: 0 });

    // The month that has left the window since the claim is still detail for this import, not history.
    const left = order(301, at(pinned, 0, 5));
    expect(await call("ingest_orders", s.key, [left], [lineFor(301)], [])).toMatchObject({ orders: 1, beyond_window: 0 });
    expect(await call("stage_history_orders", id, "run_p", [left], [lineFor(301)])).toMatchObject({ orders: 0, in_window: 1 });
    await expect(call("summarise_history_month", id, "run_p", isoMonth(pinned, 0), 1)).rejects.toThrow(/month_inside_retained_window/);
    expect(await call("stage_history_orders", id, "run_p", [order(302, at(pinned, -1, 20))], [lineFor(302)])).toMatchObject({ orders: 1, in_window: 0 });

    // A run taking over keeps the pinned start.
    const takeover = await call("claim_shop_import", id, "run_p2", 0);
    expect(new Date(takeover.window_start)).toEqual(pinned);

    // Once the import ends, the shop's writes use the current window again.
    expect(await call("finish_shop_import", id, "run_p2", "succeeded", null, null)).toEqual({ outcome: "finished" });
    expect(new Date(await call("shop_window_start", s.key))).toEqual(start);
    expect(await call("ingest_orders", s.key, [order(303, at(pinned, 0, 6))], [lineFor(303)], [])).toMatchObject({ orders: 0, beyond_window: 1 });
    for (let remaining = 1; remaining > 0; ) remaining = (await call("discard_history_stage", id, null, 20_000)).remaining;
  });

  it("lets only the run holding the import stage, summarise or discard, and fences a takeover until a batch commits", async () => {
    const s = await boundShop();
    const start = await windowStart();
    const { id } = await claimedImport(s, "run_1");
    const order = (orderId) => mapOrder(s, { id: orderId, at: at(start, -2, 10), customer: null, test: false, cancelled: false, subtotal: 10, discounts: 0, tax: 0, shipping: 0, total: 10, refunded: 0 });
    const line = (orderId) => mapLine({ id: orderId * 10, order: orderId, product: 7, quantity: 1, price: 10, discount: 0, refunded: 0 });

    expect(await call("stage_history_orders", id, "run_1", [order(401)], [line(401)])).toMatchObject({ orders: 1, lines: 1 });
    await expect(call("stage_history_orders", id, "run_other", [order(402)], [line(402)])).rejects.toThrow(/import_not_running/);
    await expect(call("discard_history_stage", id, null, 100)).rejects.toThrow(/import_not_owned/);

    // A takeover waits for a batch that is still being written.
    const writer = await pool.connect();
    const claimer = await pool.connect();
    try {
      await writer.query("begin");
      await writer.query("set local role service_role");
      await writer.query(rpcSql("stage_history_orders", [1, 2, 3, 4]), params([id, "run_1", [order(403)], [line(403)]]));
      await claimer.query("begin");
      await claimer.query("set local lock_timeout = '300ms'");
      await expect(claimer.query("select public.claim_shop_import($1, 'run_2', 0)", [id])).rejects.toThrow(/lock timeout/);
      await claimer.query("rollback");
      await writer.query("commit");
    } finally {
      writer.release();
      claimer.release();
    }
    expect(await call("claim_shop_import", id, "run_2", 0)).toMatchObject({ outcome: "claimed" });

    // The superseded run can no longer touch the staging.
    await expect(call("stage_history_orders", id, "run_1", [order(404)], [line(404)])).rejects.toThrow(/import_not_running/);
    await expect(call("summarise_history_month", id, "run_1", isoMonth(start, -2), 1)).rejects.toThrow(/import_not_running/);
    await expect(call("discard_history_stage", id, "run_1", 100)).rejects.toThrow(/import_not_owned/);
    expect(await staged(id)).toEqual({ orders: 2, lines: 2 });

    expect(await call("summarise_history_month", id, "run_2", isoMonth(start, -2), 1)).toEqual({ product_months: 1, store_months: 1 });
    expect(await call("finish_shop_import", id, "run_2", "failed", null, "test")).toEqual({ outcome: "finished" });
    // A finished import's staging is the reconcile job's to clear.
    expect(await call("discard_history_stage", id, null, 100)).toEqual({ deleted: 4, remaining: 0 });
  });
});
