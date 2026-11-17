/**
 * Retention evaluation (Phase 1, task 11). LOCAL POSTGRES ONLY. Deletes nothing
 * real: it builds the task 10 capacity fixtures (36 months of orders per
 * profile) in throwaway databases and measures, per profile:
 *
 *  - the line-level order data (orders, line items, refunds, returns, return
 *    line items) kept under 12, 24 and 36 months of retention, by row share,
 *    validated against a real copy for one profile;
 *  - monthly aggregates that would preserve what older rows contribute:
 *    product-by-month (with the fixture's even spread of sales across products,
 *    a worst case, and with a Pareto spread where about 20% of products take
 *    80% of sales) and store-by-month;
 *  - everything else (catalog, customers, metrics), which retention does not touch.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres \
 *     node scripts/ops/retention-evaluation.mjs [--profiles small,medium,large,xlarge] [--validate large] [--out report.json]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { PROFILES, loadShop, measure } from "./capacity-fixtures.mjs";

const MONTHS = 36;
const WINDOWS = [12, 24, 36];
const ORDER_TABLES = ["orders", "order_line_items", "refunds", "returns", "return_line_items"];

/** Share of each order table's rows inside the last `months` months. */
async function windowShares(client, months) {
  const cut = `now() - interval '${months} months'`;
  const { rows: [r] } = await client.query(`
    select (select count(*) filter (where processed_at > ${cut})::float / greatest(count(*), 1) from public.orders) as orders,
           (select count(*) filter (where o.processed_at > ${cut})::float / greatest(count(*), 1)
              from public.order_line_items li join public.orders o on o.shop_id = li.shop_id and o.shopify_id = li.order_shopify_id) as order_line_items,
           (select count(*) filter (where o.processed_at > ${cut})::float / greatest(count(*), 1)
              from public.refunds r join public.orders o on o.shop_id = r.shop_id and o.shopify_id = r.order_shopify_id) as refunds,
           (select count(*) filter (where o.processed_at > ${cut})::float / greatest(count(*), 1)
              from public.returns r join public.orders o on o.shop_id = r.shop_id and o.shopify_id = r.order_shopify_id) as returns,
           (select count(*) filter (where o.processed_at > ${cut})::float / greatest(count(*), 1)
              from public.return_line_items rl join public.returns r on r.shop_id = rl.shop_id and r.shopify_id = rl.return_shopify_id
              join public.orders o on o.shop_id = r.shop_id and o.shopify_id = r.order_shopify_id) as return_line_items`);
  return r;
}

/** Builds a monthly product aggregate (even or Pareto spread of sales) and returns its rows and bytes. */
async function productMonthly(client, products, spread) {
  // Pareto: map each line item to a product through u^7, so ~20% of products take ~80% of line items.
  const product = spread === "pareto"
    ? `1000000001 + floor(${products} * power(((hashint8(li.shopify_id) & 2147483647)::float / 2147483648), 7))::bigint`
    : "li.product_shopify_id";
  const table = `x_product_monthly_${spread}`;
  await client.query(`drop table if exists ${table}`);
  await client.query(`
    create table ${table} as
      select li.shop_id, ${product} as product_shopify_id, date_trunc('month', o.processed_at)::date as month,
             count(distinct o.shopify_id)::int as orders, sum(li.quantity)::int as units,
             sum(li.unit_price * li.quantity)::numeric(20, 4) as gross_sales, sum(li.total_discount)::numeric(20, 4) as discounts,
             sum(li.refunded_quantity)::int as refunded_units, 0::int as returned_units,
             count(distinct o.customer_shopify_id)::int as customers
        from public.order_line_items li join public.orders o on o.shop_id = li.shop_id and o.shopify_id = li.order_shopify_id
       where li.product_shopify_id is not null group by 1, 2, 3`);
  await client.query(`alter table ${table} add primary key (shop_id, product_shopify_id, month)`);
  await client.query(`vacuum analyze ${table}`);
  const { rows: [r] } = await client.query(`select count(*)::int as rows, pg_total_relation_size('${table}') as bytes from ${table}`);
  return { rows: r.rows, bytes: Number(r.bytes) };
}

async function storeMonthly(client) {
  await client.query("drop table if exists x_store_monthly");
  await client.query(`
    create table x_store_monthly as
      select shop_id, date_trunc('month', processed_at)::date as month, count(*)::int as orders, sum(total_price)::numeric(20, 4) as gross_sales,
             sum(total_discounts)::numeric(20, 4) as discounts, sum(total_refunded)::numeric(20, 4) as refunded,
             count(distinct customer_shopify_id)::int as customers
        from public.orders group by 1, 2`);
  await client.query("alter table x_store_monthly add primary key (shop_id, month)");
  const { rows: [r] } = await client.query("select count(*)::int as rows, pg_total_relation_size('x_store_monthly') as bytes from x_store_monthly");
  return { rows: r.rows, bytes: Number(r.bytes) };
}

/** Real copies of the order tables inside the window, with the same keys and indexes, to check the row-share estimate. */
async function measuredWindow(client, months) {
  const cut = `now() - interval '${months} months'`;
  await client.query(`
    create table v_orders as select * from public.orders where processed_at > ${cut};
    alter table v_orders add primary key (shop_id, shopify_id);
    create index on v_orders (shop_id, processed_at);
    create index on v_orders (shop_id, customer_shopify_id, processed_at) where customer_shopify_id is not null;
    create table v_lines as select li.* from public.order_line_items li join v_orders o on o.shop_id = li.shop_id and o.shopify_id = li.order_shopify_id;
    alter table v_lines add primary key (shop_id, shopify_id);
    create index on v_lines (shop_id, order_shopify_id);
    create index on v_lines (shop_id, product_shopify_id) where product_shopify_id is not null;`);
  // VACUUM cannot run inside the implicit transaction of a multi-statement query.
  await client.query("vacuum analyze v_orders");
  await client.query("vacuum analyze v_lines");
  const { rows: [r] } = await client.query("select pg_total_relation_size('v_orders') + pg_total_relation_size('v_lines') as bytes");
  await client.query("drop table v_orders; drop table v_lines;");
  return Number(r.bytes);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const url = process.env.DATABASE_URL;
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) { console.error("Refusing: runs only against a local Postgres (DATABASE_URL)."); process.exit(2); }
  const profiles = (value("--profiles") ?? "small,medium,large,xlarge").split(",");
  const validate = value("--validate") ?? "large";
  const dbUrl = (name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

  const root = new pg.Client({ connectionString: url });
  await root.connect();
  const report = { generated_at: new Date().toISOString(), months_of_history: MONTHS, profiles: {} };
  try {
    await root.query("drop database if exists ret_template");
    await root.query("create database ret_template");
    const provision = spawnSync(process.execPath, ["supabase/provision.mjs"], { env: { ...process.env, DATABASE_URL: dbUrl("ret_template") }, encoding: "utf8" });
    if (provision.status !== 0) throw new Error(`provision failed: ${provision.stderr || provision.stdout}`);
    for (const name of profiles) {
      const db = `ret_${name}`;
      await root.query(`drop database if exists ${db}`);
      await root.query(`create database ${db} template ret_template`);
      const c = new pg.Client({ connectionString: dbUrl(db) });
      await c.connect();
      try {
        const { products, orders } = PROFILES[name];
        await loadShop(c, { products, orders, months: MONTHS });
        await c.query("vacuum analyze");
        const sizes = await measure(c);
        const byTable = Object.fromEntries(sizes.tables.map((t) => [t.table, t.total]));
        const orderBytes = ORDER_TABLES.reduce((sum, t) => sum + (byTable[t] ?? 0), 0);
        const windows = {};
        for (const months of WINDOWS) {
          const shares = await windowShares(c, months);
          windows[months] = Math.round(ORDER_TABLES.reduce((sum, t) => sum + (byTable[t] ?? 0) * shares[t], 0));
        }
        const even = await productMonthly(c, products, "even");
        const pareto = await productMonthly(c, products, "pareto");
        const store = await storeMonthly(c);
        const entry = {
          products, orders, mirror_bytes: sizes.mirror, order_bytes: orderBytes, other_bytes: sizes.mirror - orderBytes,
          customers_bytes: byTable.customers ?? 0, line_level_bytes_by_window: windows,
          product_monthly: { even, pareto, months: MONTHS }, store_monthly: store,
        };
        if (name === validate) {
          const estimated = Math.round((byTable.orders + byTable.order_line_items) * (await windowShares(c, 24)).orders);
          entry.validation_24_months = { estimated_orders_and_lines_bytes: estimated, measured_orders_and_lines_bytes: await measuredWindow(c, 24) };
        }
        report.profiles[name] = entry;
        const mb = (b) => (b / 1048576).toFixed(1);
        console.log(`${name}: order data ${mb(orderBytes)} MB (12/24/36 months: ${WINDOWS.map((m) => mb(windows[m])).join(" / ")}), product-monthly even ${mb(even.bytes)} MB, pareto ${mb(pareto.bytes)} MB`);
      } finally {
        await c.end();
        await root.query(`drop database if exists ${db}`);
      }
    }
  } finally {
    await root.query("drop database if exists ret_template");
    await root.end();
  }
  const out = value("--out");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
