/**
 * Retention summaries benchmark (Phase 1, task 12). LOCAL POSTGRES ONLY.
 * Builds the capacity fixtures (36 months of orders, Pareto spread of sales
 * across products) in throwaway databases with migration 0030 applied, and
 * measures the real summaries rather than the stand-ins of task 11:
 *
 *  - rows and bytes of product_monthly_metrics, store_monthly_metrics and
 *    cohort_monthly_outcomes after a refresh over all 36 months, and what the
 *    products' sale dates add;
 *  - how long that full refresh takes (Phase 2's first refresh after an
 *    import), and the daily refresh over the months not yet final;
 *  - retention_status, and a customers/redact of one customer.
 *
 * Timings are local (Docker, Postgres 17); Supabase's shared compute is slower.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres \
 *     node scripts/ops/retention-summaries.mjs [--profiles large,xlarge] [--out report.json]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { PROFILES, loadShop, measure } from "./capacity-fixtures.mjs";

const MONTHS = 36;
const DOMAIN = "capacity-fixture.myshopify.com";
const SUMMARIES = ["product_monthly_metrics", "store_monthly_metrics", "cohort_monthly_outcomes"];

async function timed(client, sql, params) {
  const started = process.hrtime.bigint();
  const { rows } = await client.query(sql, params);
  return { ms: Number((process.hrtime.bigint() - started) / 1_000_000n), rows };
}

const relationBytes = async (client, table) =>
  Number((await client.query("select pg_total_relation_size($1::regclass) as b", [`public.${table}`])).rows[0].b);

async function benchmark(client, { products, orders }) {
  await loadShop(client, { products, orders, months: MONTHS, distribution: "pareto" });
  const { rows: [{ key }] } = await client.query("select shop_key as key from public.shops where myshopify_domain = $1", [DOMAIN]);
  await client.query("vacuum full public.products");
  await client.query("vacuum analyze");
  const before = await measure(client);
  const productsBefore = await relationBytes(client, "products");

  const full = await timed(client,
    "select public.refresh_monthly_aggregates($1, (date_trunc('month', now()) - make_interval(months => $2))::date, now()::date) as r", [key, MONTHS]);
  const daily = await timed(client,
    "select public.refresh_monthly_aggregates($1, (now() - interval '485 days')::date, now()::date) as r", [key]);
  // One call per month, as an API caller under PostgREST's 8 s statement timeout would run it.
  const perMonth = [];
  for (let back = MONTHS; back >= 0; back--) {
    const month = "(date_trunc('month', now()) - make_interval(months => $2))::date";
    perMonth.push((await timed(client, `select public.refresh_monthly_aggregates($1, ${month}, ${month}) as r`, [key, back])).ms);
  }

  // The same sequence as before the refresh, so both sizes include the free-space and visibility maps.
  await client.query("vacuum full public.products");
  await client.query("vacuum analyze public.products");
  for (const table of SUMMARIES) await client.query(`vacuum analyze public.${table}`);
  const summaries = {};
  for (const table of SUMMARIES) {
    const { rows: [r] } = await client.query(
      `select count(*)::int as rows, count(*) filter (where finalized_at is not null)::int as final from public.${table} where shop_key = $1`, [key]);
    summaries[table] = { ...r, bytes: await relationBytes(client, table) };
  }
  const { rows: [dated] } = await client.query("select count(*) filter (where first_sold_at is not null)::int as dated, count(*)::int as products from public.products where shop_key = $1", [key]);
  const productsAfter = await relationBytes(client, "products");

  const status = await timed(client, "select public.retention_status($1) as r", [key]);
  const { rows: [subject] } = await client.query(
    `select customer_shopify_id as customer, array_agg(shopify_id) as orders from public.orders
      where shop_key = $1 and customer_shopify_id is not null group by 1 order by count(*) desc limit 1`, [key]);
  const redact = await timed(client,
    "select public.record_customer_compliance('customers/redact', null, $1, $2, now(), $3, $4) as r",
    [DOMAIN, `benchmark-${Date.now()}`, subject.customer, subject.orders]);

  const summaryBytes = SUMMARIES.reduce((sum, t) => sum + summaries[t].bytes, 0);
  return {
    products, orders, mirror_bytes: before.mirror,
    summaries, summary_bytes: summaryBytes, summary_share_of_mirror: Number((summaryBytes / before.mirror).toFixed(4)),
    sale_dates: { ...dated, products_bytes_before: productsBefore, products_bytes_after: productsAfter },
    refresh: {
      full_ms: full.ms, full: full.rows[0].r, daily_ms: daily.ms, daily: daily.rows[0].r,
      month_by_month: { calls: perMonth.length, max_ms: Math.max(...perMonth), total_ms: perMonth.reduce((a, b) => a + b, 0) },
    },
    retention_status: { ms: status.ms, result: status.rows[0].r },
    redact: { ms: redact.ms, orders_named: subject.orders.length, result: redact.rows[0].r },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const url = process.env.DATABASE_URL;
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) { console.error("Refusing: runs only against a local Postgres (DATABASE_URL)."); process.exit(2); }
  const profiles = (value("--profiles") ?? "large,xlarge").split(",");
  const dbUrl = (name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

  const root = new pg.Client({ connectionString: url });
  await root.connect();
  const report = { generated_at: new Date().toISOString(), months_of_history: MONTHS, distribution: "pareto", profiles: {} };
  try {
    await root.query("drop database if exists sum_template");
    await root.query("create database sum_template");
    const provision = spawnSync(process.execPath, ["supabase/provision.mjs"], { env: { ...process.env, DATABASE_URL: dbUrl("sum_template") }, encoding: "utf8" });
    if (provision.status !== 0) throw new Error(`provision failed: ${provision.stderr || provision.stdout}`);
    for (const name of profiles) {
      const db = `sum_${name}`;
      await root.query(`drop database if exists ${db}`);
      await root.query(`create database ${db} template sum_template`);
      const c = new pg.Client({ connectionString: dbUrl(db) });
      await c.connect();
      try {
        const entry = await benchmark(c, PROFILES[name]);
        report.profiles[name] = entry;
        const mb = (b) => (b / 1048576).toFixed(2);
        console.log(`${name}: summaries ${mb(entry.summary_bytes)} MB (${(entry.summary_share_of_mirror * 100).toFixed(1)}% of ${mb(entry.mirror_bytes)} MB); full refresh ${entry.refresh.full_ms} ms, daily ${entry.refresh.daily_ms} ms, slowest single month ${entry.refresh.month_by_month.max_ms} ms; status ${entry.retention_status.ms} ms; redact ${entry.redact.ms} ms`);
      } finally {
        await c.end();
        await root.query(`drop database if exists ${db}`);
      }
    }
  } finally {
    await root.query("drop database if exists sum_template");
    await root.end();
  }
  const out = value("--out");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
