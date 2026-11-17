/**
 * Real Postgres tests for the retention architecture (Phase 1, task 12, on
 * the task 11 decisions): migration 0030's monthly summaries, product sale
 * dates, retention status and customer redaction. Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 10 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

/** Statements as service_role, in one transaction, as the application runs them. */
async function asService(statements) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const results = [];
    for (const [sql, params] of statements) results.push((await client.query(sql, params)).rows);
    await client.query("commit");
    return results;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
const service = async (sql, params) => (await asService([[sql, params]]))[0];
const call = async (fn, ...args) =>
  (await service(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args))[0].result;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const domain = () => `r-${tag()}.myshopify.com`;
const shopifyId = () => Math.floor(Math.random() * 9e12) + 1e12;
async function newShop() {
  const shop = domain();
  const shopify = shopifyId();
  const { id } = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning shop_key as id", [shopify, shop]);
  return { id, shop, shopify };
}

const DAY = 86_400_000;
const plus = (at, days) => new Date(at.getTime() + days * DAY);
const isoDate = (at) => at.toISOString().slice(0, 10);
/** Month starts from the database clock: one long final, and the current one still open. */
const anchors = () =>
  one("select date_trunc('month', now() - interval '20 months') as old, date_trunc('month', now()) as current");

const product = (s, id) => ["insert into public.products (shop_key, shopify_id, title, status) values ($1, $2, 'Product', 'active')", [s.id, id]];
const customer = (s, id, firstOrder, firstAt, lastAt = firstAt) =>
  ["insert into public.customers (shop_key, shopify_id, first_order_shopify_id, first_order_at, last_order_at) values ($1, $2, $3, $4, $5)", [s.id, id, firstOrder, firstAt, lastAt]];
const order = (s, id, at, { customer: buyer = null, total = 10, test = false, cancelled = false, city = null, province = null, country = null } = {}) => [
  `insert into public.orders (shop_key, shopify_id, shopify_created_at, processed_at, currency, total_price, customer_shopify_id,
     is_test, cancelled_at, ship_city, ship_province_code, ship_country_code)
   values ($1, $2, $3, $3, 'GBP', $4, $5, $6, case when $7 then $3::timestamptz end, $8, $9, $10)`,
  [s.id, id, at, total, buyer, test, cancelled, city, province, country],
];
const line = (s, id, orderId, productId, quantity, unitPrice, { discount = 0, refunded = 0 } = {}) => [
  `insert into public.order_line_items (shop_key, shopify_id, order_shopify_id, product_shopify_id, quantity, unit_price, total_discount, refunded_quantity)
   values ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [s.id, id, orderId, productId, quantity, unitPrice, discount, refunded],
];
const refresh = (s, from, to) => call("refresh_monthly_aggregates", s.id, isoDate(from), isoDate(to), 1);

const productMonths = (s) => q(
  `select product_shopify_id::int as product, month::text as month, orders, units, gross_sales::float8 as gross, discounts::float8 as discounts,
          refunded_units as refunded, returned_units as returned, customers, first_time_customers as first_time, finalized_at is not null as final
     from public.product_monthly_metrics where shop_key = $1 order by month, product`, [s.id]);
const storeMonths = (s) => q(
  `select month::text as month, orders, units, total_price::float8 as total, customers, new_customers, finalized_at is not null as final
     from public.store_monthly_metrics where shop_key = $1 order by month`, [s.id]);
const cohorts = (s) => q(
  `select cohort_month::text as month, first_time_customers as customers, repeat_30d, repeat_60d, repeat_90d, repeat_180d, repeat_365d,
          first_order_revenue::float8 as first_revenue, revenue_60d::float8 as revenue_60d, finalized_at is not null as final
     from public.cohort_monthly_outcomes where shop_key = $1 order by cohort_month`, [s.id]);

/**
 * Old month: c101 orders twice (1001, then 1002 ten days later), c102 once
 * (1003), plus a test and a cancelled order that must not count. Current
 * month: c103's first order (2001).
 */
async function seedHistory(s, old, current) {
  await asService([
    product(s, 10), product(s, 20),
    customer(s, 101, 1001, plus(old, 2), plus(old, 12)),
    customer(s, 102, 1003, plus(old, 15)),
    customer(s, 103, 2001, current),
    order(s, 1001, plus(old, 2), { customer: 101, total: 50 }),
    order(s, 1002, plus(old, 12), { customer: 101, total: 30 }),
    order(s, 1003, plus(old, 15), { customer: 102, total: 20 }),
    order(s, 1004, plus(old, 3), { total: 99, test: true }),
    order(s, 1005, plus(old, 4), { total: 99, cancelled: true }),
    order(s, 2001, current, { customer: 103, total: 10 }),
    line(s, 5001, 1001, 10, 2, 20),
    line(s, 5002, 1001, 20, 1, 5),
    line(s, 5003, 1002, 10, 1, 30, { refunded: 1 }),
    line(s, 5004, 1003, 20, 4, 5, { discount: 2 }),
    line(s, 5005, 1004, 10, 9, 1),
    line(s, 5006, 1005, 10, 9, 1),
    line(s, 5007, 2001, 10, 1, 10),
    ["insert into public.returns (shop_key, shopify_id, order_shopify_id, status) values ($1, 7001, 1003, 'closed')", [s.id]],
    ["insert into public.return_line_items (shop_key, shopify_id, return_shopify_id, line_item_shopify_id, quantity, return_reason) values ($1, 7002, 7001, 5004, 1, 'defective')", [s.id]],
  ]);
}

describe("monthly summaries (task 11 decisions 2, 4 and 5)", () => {
  it("summarises each month by product, store and anonymised cohort, leaving out test and cancelled orders", async () => {
    const s = await newShop();
    const { old, current } = await anchors();
    await seedHistory(s, old, current);

    expect(await refresh(s, old, current)).toEqual({ product_months: 3, store_months: 2, cohort_months: 2, products_dated: 2 });
    const [o, c] = [isoDate(old), isoDate(current)];
    expect(await productMonths(s)).toEqual([
      { product: 10, month: o, orders: 2, units: 3, gross: 70, discounts: 0, refunded: 1, returned: 0, customers: 1, first_time: 1, final: true },
      { product: 20, month: o, orders: 2, units: 5, gross: 25, discounts: 2, refunded: 0, returned: 1, customers: 2, first_time: 2, final: true },
      { product: 10, month: c, orders: 1, units: 1, gross: 10, discounts: 0, refunded: 0, returned: 0, customers: 1, first_time: 1, final: false },
    ]);
    expect(await storeMonths(s)).toEqual([
      { month: o, orders: 3, units: 8, total: 100, customers: 2, new_customers: 2, final: true },
      { month: c, orders: 1, units: 1, total: 10, customers: 1, new_customers: 1, final: false },
    ]);
    // c101 came back within 30 days; c102 did not. Revenue within 60 days: c101 50 + 30, c102 20.
    expect(await cohorts(s)).toEqual([
      { month: o, customers: 2, repeat_30d: 1, repeat_60d: 1, repeat_90d: 1, repeat_180d: 1, repeat_365d: 1, first_revenue: 70, revenue_60d: 100, final: true },
      { month: c, customers: 1, repeat_30d: 0, repeat_60d: 0, repeat_90d: 0, repeat_180d: 0, repeat_365d: 0, first_revenue: 10, revenue_60d: 10, final: false },
    ]);
    expect(await q("select shopify_id::int as id, first_sold_at, last_sold_at from public.products where shop_key = $1 order by shopify_id", [s.id])).toEqual([
      { id: 10, first_sold_at: plus(old, 2), last_sold_at: current },
      { id: 20, first_sold_at: plus(old, 2), last_sold_at: plus(old, 15) },
    ]);
  });

  it("keeps no customer identifier in any summary", async () => {
    const columns = (await q(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name in ('product_monthly_metrics', 'store_monthly_metrics', 'cohort_monthly_outcomes')`))
      .filter((row) => /customer_(shopify_)?id|email|phone|name|address|city/.test(row.column_name));
    expect(columns).toEqual([]);
  });

  it("never changes a final month, recomputes open ones, and keeps history and sale dates when the orders behind them are gone", async () => {
    const s = await newShop();
    const { old, current } = await anchors();
    await seedHistory(s, old, current);
    await refresh(s, old, current);
    const before = { products: await productMonths(s), stores: await storeMonths(s), cohorts: await cohorts(s) };
    const stamps = await q("select month::text, computed_at from public.store_monthly_metrics where shop_key = $1 order by month", [s.id]);

    // Late changes: the final month's lines change, and so does the open month's.
    await asService([
      ["update public.order_line_items set quantity = 7 where shop_key = $1 and shopify_id = 5003", [s.id]],
      ["update public.order_line_items set quantity = 3 where shop_key = $1 and shopify_id = 5007", [s.id]],
    ]);
    expect(await refresh(s, old, current)).toEqual({ product_months: 1, store_months: 1, cohort_months: 1, products_dated: 0 });
    const after = await productMonths(s);
    expect(after.slice(0, 2)).toEqual(before.products.slice(0, 2));
    expect(after[2]).toMatchObject({ month: isoDate(current), units: 3, final: false });
    const restamped = await q("select month::text, computed_at from public.store_monthly_metrics where shop_key = $1 order by month", [s.id]);
    expect(restamped[0]).toEqual(stamps[0]);

    // What pruning would do (a throwaway test shop): the old month's orders and customers go; its history stays.
    await asService([
      ["delete from public.orders where shop_key = $1 and processed_at < $2", [s.id, plus(old, 28)]],
      ["delete from public.customers where shop_key = $1 and shopify_id in (101, 102)", [s.id]],
    ]);
    await refresh(s, old, current);
    expect((await productMonths(s)).slice(0, 2)).toEqual(before.products.slice(0, 2));
    expect((await storeMonths(s))[0]).toEqual(before.stores[0]);
    expect((await cohorts(s))[0]).toEqual(before.cohorts[0]);
    expect(await one("select first_sold_at from public.products where shop_key = $1 and shopify_id = 20", [s.id])).toEqual({ first_sold_at: plus(old, 2) });
  });

  it("rejects an invalid range or calculation version, and inconsistent sale dates", async () => {
    const s = await newShop();
    const { old, current } = await anchors();
    await expect(refresh(s, current, old)).rejects.toThrow(/aggregate_range_invalid/);
    await expect(call("refresh_monthly_aggregates", s.id, isoDate(old), isoDate(current), 0)).rejects.toThrow(/aggregate_range_invalid/);
    await expect(service("insert into public.products (shop_key, shopify_id, title, status, first_sold_at, last_sold_at) values ($1, 1, 'P', 'active', now(), now() - interval '1 day')", [s.id]))
      .rejects.toThrow(/products_sale_dates/);
  });
});

describe("retention status (task 11 decisions 1 and 7)", () => {
  it("reports what lies beyond 24 months, deletes nothing, and says pruning is not authorised", async () => {
    const s = await newShop();
    const at = await one(
      `select date_trunc('month', now() - interval '30 months') as m30, date_trunc('month', now() - interval '25 months') as m25,
              now() - interval '1 month' as recent, date_trunc('month', now()) as current`);
    await asService([
      product(s, 10),
      customer(s, 1, 100, plus(at.m30, 1), plus(at.m30, 2)),
      customer(s, 2, 103, at.recent),
      order(s, 100, plus(at.m30, 1), { customer: 1 }), order(s, 101, plus(at.m30, 2), { customer: 1 }), order(s, 102, plus(at.m25, 1)),
      order(s, 103, at.recent, { customer: 2 }),
      line(s, 200, 100, 10, 1, 10), line(s, 201, 101, 10, 1, 10), line(s, 202, 102, 10, 1, 10), line(s, 203, 103, 10, 1, 10),
    ]);
    const status = await call("retention_status", s.id);
    expect(status).toMatchObject({
      retention_months: 24, orders_beyond: 3, line_items_beyond: 3, customers_beyond: 1, months_beyond: 2,
      months_beyond_unsummarised: 2, pruning: "not_authorised",
    });
    expect(await one("select (select count(*)::int from public.orders where shop_key = $1) as orders, (select count(*)::int from public.order_line_items where shop_key = $1) as lines", [s.id]))
      .toEqual({ orders: 4, lines: 4 });
    expect(await one("select provolatile from pg_proc where oid = 'public.retention_status(integer)'::regprocedure")).toEqual({ provolatile: "s" });

    // Once the months beyond the window are summarised and final, nothing there would be lost.
    await refresh(s, at.m30, at.current);
    expect((await call("retention_status", s.id)).months_beyond_unsummarised).toBe(0);
  });
});

describe("customer compliance against the commerce mirror (task 11 decision 3)", () => {
  const record = (topic, s, customerId, orderIds = null, key = randomUUID()) =>
    call("record_customer_compliance", topic, s.shopify, s.shop, key, new Date(), customerId, orderIds);
  const inbox = (s, topic, payload) =>
    ["insert into public.webhook_events (shop_domain, shop_key, webhook_id, topic, payload) values ($1, $2, $3, $4, $5)", [s.shop, s.id, randomUUID(), topic, payload]];

  it("customers/redact removes the customer, the identifying fields of their orders and inbox payloads about them, and nothing else", async () => {
    const s = await newShop();
    const other = await newShop();
    await asService([
      customer(s, 501, 601, new Date()), customer(s, 502, 602, new Date()),
      order(s, 601, new Date(), { customer: 501, total: 40, city: "Leeds", province: "ENG", country: "GB" }),
      order(s, 602, new Date(), { customer: 502, city: "York", country: "GB" }),
      order(s, 603, new Date(), { city: "Hull", country: "GB" }),
      inbox(s, "orders/paid", { id: 601, customer: { id: 501 } }),
      inbox(s, "orders/updated", { id: 603 }),
      inbox(s, "customers/update", { id: 501 }),
      inbox(s, "orders/paid", { id: 602, customer: { id: 502 } }),
      customer(other, 501, 601, new Date()),
      order(other, 601, new Date(), { customer: 501, city: "Leeds", country: "GB" }),
    ]);
    const key = randomUUID();
    const result = await record("customers/redact", s, 501, [601, 603], key);
    expect(result).toMatchObject({ outcome: "completed", resolution: "customer_data_redacted", redacted: { customers: 1, orders: 2, inbox: 3 } });

    expect(await q("select shopify_id::int as id from public.customers where shop_key = $1", [s.id])).toEqual([{ id: 502 }]);
    expect(await q(
      "select shopify_id::int as id, customer_shopify_id::int as buyer, ship_city, ship_province_code, ship_country_code, total_price::float8 as total from public.orders where shop_key = $1 order by shopify_id", [s.id]))
      .toEqual([
        { id: 601, buyer: null, ship_city: null, ship_province_code: null, ship_country_code: "GB", total: 40 },
        { id: 602, buyer: 502, ship_city: "York", ship_province_code: null, ship_country_code: "GB", total: 10 },
        { id: 603, buyer: null, ship_city: null, ship_province_code: null, ship_country_code: "GB", total: 10 },
      ]);
    expect(await q("select topic, payload, status, last_error from public.webhook_events where shop_key = $1 order by payload is null, topic", [s.id]))
      .toEqual([
        { topic: "orders/paid", payload: { id: 602, customer: { id: 502 } }, status: "received", last_error: null },
        { topic: "customers/update", payload: null, status: "ignored", last_error: "customer_redacted" },
        { topic: "orders/paid", payload: null, status: "ignored", last_error: "customer_redacted" },
        { topic: "orders/updated", payload: null, status: "ignored", last_error: "customer_redacted" },
      ]);
    // The same Shopify customer ID in another shop is a different person.
    expect(await one("select (select count(*)::int from public.customers where shop_key = $1) as customers, (select customer_shopify_id::int from public.orders where shop_key = $1) as buyer", [other.id]))
      .toEqual({ customers: 1, buyer: 501 });
    expect(await one("select status, resolution, completed_at is not null as done, extract(day from due_at - received_at)::int as days from public.compliance_requests where id = $1", [result.compliance_request_id]))
      .toEqual({ status: "completed", resolution: "customer_data_redacted", done: true, days: 30 });

    expect(await record("customers/redact", s, 501, [601, 603], key)).toEqual({ outcome: "duplicate" });
    expect(await record("customers/redact", s, 501)).toMatchObject({ outcome: "completed", resolution: "no_customer_data_held", redacted: { customers: 0, orders: 0, inbox: 0 } });
  });

  it("customers/data_request stays open while data is held, and completes at once when none is", async () => {
    const s = await newShop();
    await asService([customer(s, 801, 901, new Date()), order(s, 901, new Date(), { customer: 801 })]);

    const held = await record("customers/data_request", s, 801);
    expect(held).toMatchObject({ outcome: "open", resolution: null });
    expect(await one(
      `select r.status, r.completed_at, e.outcome from public.compliance_requests r join public.shop_lifecycle_events e on e.id = r.lifecycle_event_id where r.id = $1`,
      [held.compliance_request_id])).toEqual({ status: "open", completed_at: null, outcome: "customer_data_held" });
    expect(await one("select count(*)::int as n from public.customers where shop_key = $1", [s.id])).toEqual({ n: 1 });

    expect((await record("customers/data_request", s, null, [901])).outcome).toBe("open");
    expect(await record("customers/data_request", s, 999)).toMatchObject({ outcome: "completed", resolution: "no_customer_data_held" });
    const unknown = { shop: domain(), shopify: shopifyId() };
    expect(await record("customers/data_request", unknown, 801)).toMatchObject({ outcome: "completed", resolution: "no_customer_data_held" });
  });
});

describe("privileges", () => {
  it("lets only service_role run the new functions, and keeps the summaries read-only to it", async () => {
    for (const fn of [
      "refresh_monthly_aggregates(integer, date, date, integer)",
      "retention_status(integer)",
      "record_customer_compliance(text, bigint, text, text, timestamptz, bigint, bigint[])",
    ]) {
      const row = await one(
        `select has_function_privilege('service_role', $1, 'execute') as service, has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authed`, [`public.${fn}`]);
      expect(row, fn).toEqual({ service: true, anon: false, authed: false });
    }
    expect(await one("select count(*)::int as n from pg_proc where proname = 'record_customer_compliance'")).toEqual({ n: 1 });
    const s = await newShop();
    await expect(service("insert into public.store_monthly_metrics (shop_key, month, calc_version, currency) values ($1, date_trunc('month', now()), 1, 'GBP')", [s.id]))
      .rejects.toThrow(/permission denied/);
  });
});
