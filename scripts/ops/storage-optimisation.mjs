/**
 * Storage optimisation review (Phase 1, task 12; ADR 0002 decision 2).
 * LOCAL POSTGRES ONLY.
 *
 * Builds the very large capacity fixture (70k products, 500k orders over 36
 * months) with a Pareto sales spread, then measures each candidate on its own:
 * a control copy and a changed copy of the affected tables, both rebuilt with
 * the same indexes, so the difference belongs to the candidate alone. Index
 * removals are judged on query time, measured with and without the index
 * inside transactions that are rolled back.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres \
 *     node scripts/ops/storage-optimisation.mjs [--profile xlarge] [--out report.json]
 *
 * It measures the 0024/0025 design, before migration 0029 applied the accepted
 * candidates. To reproduce the review, run it at commit 01ab208.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { MIRROR, PROFILES, loadShop, measure } from "./capacity-fixtures.mjs";

const relSize = async (c, rel) => Number((await c.query("select pg_total_relation_size($1::regclass) as b", [rel])).rows[0].b);
const columns = async (c, table) =>
  (await c.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [table])).rows.map((r) => r.column_name);

/** Copies a table through a select list, rebuilds its indexes on the copy, and returns the copy's total size. */
async function copyTable(c, table, name, { select = "*", where = "", rewrite = (d) => d, skipIndexes = [] } = {}) {
  await c.query(`drop table if exists ${name}`);
  await c.query(`create table ${name} as select ${select} from public.${table} ${where}`);
  const defs = (await c.query("select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = $1 order by indexname", [table])).rows;
  let i = 0;
  for (const { indexname, indexdef } of defs) {
    if (skipIndexes.includes(indexname)) continue;
    await c.query(rewrite(indexdef.replace(/INDEX \S+ ON public\.\S+ /, `INDEX ${name}_i${i++} ON public.${name} `)));
  }
  await c.query(`vacuum analyze ${name}`);
  const bytes = await relSize(c, name);
  await c.query(`drop table ${name}`);
  return bytes;
}

/** A select list that keeps every column, replacing the named ones. */
async function selectWith(c, table, replace = {}, omit = []) {
  return (await columns(c, table)).filter((col) => !omit.includes(col)).map((col) => replace[col] ?? col).join(", ");
}

async function timed(c, sql, params, runs = 3) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    await c.query(sql, params);
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return Math.round(times.sort((a, b) => a - b)[Math.floor(runs / 2)] * 10) / 10;
}

/** A query's median time, or null when it exceeds the statement timeout. */
async function attempt(c, sql, params) {
  await c.query("savepoint attempt");
  try {
    const ms = await timed(c, sql, params);
    await c.query("release savepoint attempt");
    return ms;
  } catch (error) {
    await c.query("rollback to savepoint attempt");
    if (error.code === "57014") return null;
    throw error;
  }
}

/** Median time of each query with the index, then with it dropped; null means over 60 s. All rolled back. */
async function withoutIndex(c, index, queries) {
  const out = {};
  await c.query("begin");
  try {
    await c.query("set local statement_timeout = '60s'");
    for (const [name, [sql, params]] of Object.entries(queries)) out[name] = { with_index_ms: await attempt(c, sql, params) };
    await c.query(`drop index public.${index}`);
    for (const [name, [sql, params]] of Object.entries(queries)) out[name].without_index_ms = await attempt(c, sql, params);
  } finally {
    await c.query("rollback");
  }
  return out;
}

export async function review(c, { products, shop, mirror }) {
  const candidates = [];
  const record = (entry) => {
    entry.saving_bytes = entry.control_bytes - entry.changed_bytes;
    entry.saving_share_of_mirror = Math.round((entry.saving_bytes / mirror) * 1000) / 10;
    candidates.push(entry);
    console.log(`${entry.id}: ${(entry.control_bytes / 1048576).toFixed(1)} -> ${(entry.changed_bytes / 1048576).toFixed(1)} MB (${entry.saving_share_of_mirror}% of the mirror)`);
  };

  // 1. Integer shop key in every row and index of the mirror.
  {
    let control = 0;
    let changed = 0;
    for (const t of MIRROR) {
      const cols = await columns(c, t);
      if (!cols.includes("shop_id")) continue;
      control += await copyTable(c, t, `ctl_${t}`);
      changed += await copyTable(c, t, `key_${t}`, {
        select: cols.map((col) => (col === "shop_id" ? "1::integer as shop_key" : col)).join(", "),
        rewrite: (d) => d.replace(/\bshop_id\b/g, "shop_key"),
      });
    }
    record({ id: "integer_shop_key", tables: "all 20 mirror tables", control_bytes: control, changed_bytes: changed });
  }

  // 2. Catalog: description excerpt of 300 characters instead of up to 600.
  record({ id: "description_300", tables: "products", control_bytes: await copyTable(c, "products", "ctl_products"),
    changed_bytes: await copyTable(c, "products", "chg_products", { select: await selectWith(c, "products", { description_excerpt: "left(description_excerpt, 300) as description_excerpt" }) }) });

  // 3. Catalog: variants without selected_options (the title repeats the option values).
  record({ id: "variant_options_dropped", tables: "product_variants", control_bytes: await copyTable(c, "product_variants", "ctl_variants"),
    changed_bytes: await copyTable(c, "product_variants", "chg_variants", { select: await selectWith(c, "product_variants", {}, ["selected_options"]) }) });

  // 4. Orders: the raw city and presentment currency only when they differ.
  record({ id: "order_duplicates_nulled", tables: "orders", control_bytes: await copyTable(c, "orders", "ctl_orders"),
    changed_bytes: await copyTable(c, "orders", "chg_orders", { select: await selectWith(c, "orders", {
      ship_city_raw: "nullif(ship_city_raw, ship_city) as ship_city_raw", presentment_currency: "nullif(presentment_currency, currency) as presentment_currency" }) }) });

  // 5. Metafields: a per-shop key dictionary instead of namespace and key text in every row and in the primary key.
  {
    const control = await copyTable(c, "metafields", "ctl_metafields");
    await c.query(`drop table if exists dict_keys; drop table if exists dict_metafields;
      create table dict_keys as
        select (row_number() over (order by owner_type, namespace, key))::int as key_id, shop_id, owner_type, namespace, key, min(type) as type
          from public.metafields group by shop_id, owner_type, namespace, key;
      alter table dict_keys add primary key (shop_id, key_id);
      create unique index dict_keys_name on dict_keys (shop_id, owner_type, namespace, key);
      create table dict_metafields as
        select m.shop_id, m.owner_shopify_id, k.key_id, m.value_excerpt, m.value_truncated, m.shopify_updated_at, m.synced_at
          from public.metafields m join dict_keys k using (shop_id, owner_type, namespace, key);
      alter table dict_metafields add primary key (shop_id, owner_shopify_id, key_id);`);
    await c.query("vacuum analyze dict_keys");
    await c.query("vacuum analyze dict_metafields");
    const changed = (await relSize(c, "dict_keys")) + (await relSize(c, "dict_metafields"));
    await c.query("drop table dict_keys; drop table dict_metafields;");
    record({ id: "metafield_key_dictionary", tables: "metafields", control_bytes: control, changed_bytes: changed });
  }

  // 6. Metafields: values over 1,000 characters, which the claims reader discards anyway.
  const longValues = Number((await c.query("select count(*) from public.metafields where char_length(value_excerpt) > 1000")).rows[0].count);

  // 7. Metafields: one key of three (an allow-list), measured for the record.
  record({ id: "metafield_allow_list", tables: "metafields", control_bytes: await copyTable(c, "metafields", "ctl_mf2"),
    changed_bytes: await copyTable(c, "metafields", "chg_mf2", { where: "where key = 'material'" }) });

  // 8. Product metrics: rows only for (product, window) pairs with sales.
  {
    await c.query(`drop table if exists sold; create table sold as
      select distinct li.product_shopify_id, w.window_days
        from public.order_line_items li join public.orders o on o.shop_id = li.shop_id and o.shopify_id = li.order_shopify_id,
             unnest(array[7, 30, 90, 365]) as w(window_days)
       where li.product_shopify_id is not null and o.processed_at > now() - make_interval(days => w.window_days);`);
    const perWindow = (await c.query("select window_days, count(*)::int as products from sold group by 1 order by 1")).rows;
    record({ id: "product_metrics_sparse", tables: "product_metrics", control_bytes: await copyTable(c, "product_metrics", "ctl_pm"),
      changed_bytes: await copyTable(c, "product_metrics", "chg_pm", { where: "pm where exists (select 1 from sold s where s.product_shopify_id = pm.product_shopify_id and s.window_days = pm.window_days)", select: "pm.*" }),
      products_with_sales_by_window: Object.fromEntries(perWindow.map((r) => [r.window_days, r.products])), products });
    await c.query("drop table sold");
  }

  // 9. Indexes: every mirror index's size, and the query cost of removing the candidates.
  const indexes = (await c.query(`
    select i.indexrelname as index, i.relname as table, pg_relation_size(i.indexrelid) as bytes
      from pg_stat_user_indexes i where i.schemaname = 'public' and i.relname = any($1) order by bytes desc`, [MIRROR])).rows
    .map((r) => ({ ...r, bytes: Number(r.bytes) }));
  const customer = (await c.query("select customer_shopify_id from public.orders where customer_shopify_id is not null limit 1 offset 1000")).rows[0].customer_shopify_id;
  const product = (await c.query("select product_shopify_id from public.order_line_items group by 1 order by count(*) desc limit 1")).rows[0].product_shopify_id;
  const indexImpact = {
    orders_customer_idx: await withoutIndex(c, "orders_customer_idx", {
      "One customer's orders (redaction, repeat lookup)": ["select shopify_id, processed_at from public.orders where shop_id = $1 and customer_shopify_id = $2", [shop, customer]],
      "60-day repeat by first-order month (cohorts, set-based batch)": [`with ordered as (
          select customer_shopify_id, processed_at, lead(processed_at) over (partition by customer_shopify_id order by processed_at) as next_at,
                 row_number() over (partition by customer_shopify_id order by processed_at) as n
            from public.orders where shop_id = $1 and customer_shopify_id is not null)
        select date_trunc('month', processed_at), count(*), count(*) filter (where next_at <= processed_at + interval '60 days')
          from ordered where n = 1 group by 1`, [shop]],
      "60-day repeat by first-order month (cohorts, correlated form)": [`with firsts as (select customer_shopify_id, min(processed_at) as first_at from public.orders
          where shop_id = $1 and customer_shopify_id is not null group by 1)
        select date_trunc('month', f.first_at), count(*), count(*) filter (where exists (select 1 from public.orders o2 where o2.shop_id = $1
          and o2.customer_shopify_id = f.customer_shopify_id and o2.processed_at > f.first_at and o2.processed_at <= f.first_at + interval '60 days'))
          from firsts f group by 1`, [shop]],
    }),
    order_line_items_product_idx: await withoutIndex(c, "order_line_items_product_idx", {
      "One product's 365-day sales (drill-down)": [`select sum(li.quantity) from public.order_line_items li join public.orders o on o.shop_id = li.shop_id and o.shopify_id = li.order_shopify_id
        where li.shop_id = $1 and li.product_shopify_id = $2 and o.processed_at > now() - interval '365 days'`, [shop, product]],
      "Every product's 30-day units (metrics, batch)": [`select li.product_shopify_id, sum(li.quantity) from public.order_line_items li join public.orders o on o.shop_id = li.shop_id and o.shopify_id = li.order_shopify_id
        where li.shop_id = $1 and o.processed_at > now() - interval '30 days' group by 1`, [shop]],
    }),
    return_line_items_line_item_idx: await withoutIndex(c, "return_line_items_line_item_idx", {
      "Returned units per product (batch)": [`select li.product_shopify_id, sum(rl.quantity) from public.return_line_items rl
        join public.order_line_items li on li.shop_id = rl.shop_id and li.shopify_id = rl.line_item_shopify_id where rl.shop_id = $1 group by 1`, [shop]],
    }),
  };

  // 10. Inventory levels: the cost of one level per variant, which a single-location shop duplicates from the variant itself.
  const inv = (await c.query("select count(*)::int as rows, pg_total_relation_size('public.inventory_levels') as bytes from public.inventory_levels")).rows[0];

  return {
    candidates, long_metafield_values: longValues, indexes, index_impact: indexImpact,
    inventory_levels: { rows: inv.rows, bytes: Number(inv.bytes), bytes_per_level: Math.round(Number(inv.bytes) / inv.rows) },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const url = process.env.DATABASE_URL;
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) { console.error("Refusing: runs only against a local Postgres (DATABASE_URL)."); process.exit(2); }
  const profile = value("--profile") ?? "xlarge";
  const dbUrl = (name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };
  const root = new pg.Client({ connectionString: url });
  await root.connect();
  try {
    await root.query("drop database if exists opt_review");
    await root.query("create database opt_review");
    const provision = spawnSync(process.execPath, ["supabase/provision.mjs"], { env: { ...process.env, DATABASE_URL: dbUrl("opt_review") }, encoding: "utf8" });
    if (provision.status !== 0) throw new Error(`provision failed: ${provision.stderr || provision.stdout}`);
    const c = new pg.Client({ connectionString: dbUrl("opt_review") });
    await c.connect();
    try {
      const before0029 = (await c.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'shop_id'")).rowCount === 1;
      if (!before0029) throw new Error("This review measures the design before migration 0029; run it at commit 01ab208.");
      const { products, orders } = PROFILES[profile];
      const { shop } = await loadShop(c, { products, orders, months: 36, distribution: "pareto" });
      await c.query("vacuum analyze");
      const sizes = await measure(c);
      const report = { generated_at: new Date().toISOString(), profile, products, orders, distribution: "pareto", mirror_bytes: sizes.mirror, tables: sizes.tables,
        ...(await review(c, { products, shop, mirror: sizes.mirror })) };
      const out = value("--out");
      if (out) writeFileSync(out, JSON.stringify(report, null, 2));
      else console.log(JSON.stringify(report, null, 2));
    } finally {
      await c.end();
    }
  } finally {
    await root.query("drop database if exists opt_review");
    await root.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
