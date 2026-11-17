/**
 * Capacity fixtures (Phase 1, task 10; schema of migration 0029 onwards). LOCAL POSTGRES ONLY.
 *
 * Builds one synthetic shop per profile in its own throwaway database, from a
 * template provisioned with every migration, then measures what the commerce
 * mirror (0024/0025) really costs: heap, index and TOAST bytes per table, rows,
 * bytes per product and per order, the shop's full deletion, and a few
 * representative queries. Orders are spread over --months of history (default
 * 36) so the retention evaluation (task 11) can measure shorter windows from
 * the same data.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres \
 *     node scripts/ops/capacity-fixtures.mjs --profiles small,medium,large,xlarge [--months 36] [--keep] [--out report.json]
 *
 * These are local benchmarks: sizes carry over to Supabase (same Postgres
 * storage format), timings do not. Refuses any database that is not on
 * 127.0.0.1 or localhost. Databases are named cap_<profile> and dropped
 * afterwards unless --keep.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const PROFILES = {
  small: { products: 500, orders: 5_000 },
  medium: { products: 5_000, orders: 50_000 },
  large: { products: 20_000, orders: 200_000 },
  xlarge: { products: 70_000, orders: 500_000 },
};

/** Row counts derived from a profile, documented in architecture/capacity-measurements.md. */
export function shape({ products, orders }) {
  return {
    products,
    variants: products * 3,
    locations: 3,
    inventory_levels: products * 3 * 2,
    customers: Math.round(orders * 0.6),
    orders,
    line_items: orders + Math.floor(orders / 2),
    refunds: Math.floor(orders / 33),
    returns: Math.floor(orders / 50),
    metafields: products * 3,
    metaobject_definitions: 5,
    metaobjects: Math.min(Math.round(products * 0.05), 5000),
    product_metrics_at_most: products * 4, // sparse: only products that sold in each window
    store_metrics: 7,
  };
}

export const MIRROR = [
  "products", "product_variants", "inventory_locations", "inventory_levels", "customers", "orders", "order_line_items",
  "refunds", "returns", "return_line_items", "metafields", "metaobject_definitions", "metaobjects", "shop_settings",
  "shop_access", "sync_runs", "sync_checkpoints", "webhook_events", "product_metrics", "store_metrics",
];

/** Loads one synthetic shop, entirely inside Postgres. */
export async function loadShop(client, { products, orders, months = 36, domain = "capacity-fixture.myshopify.com", distribution = "even" }) {
  const s = shape({ products, orders });
  // Which product each line item sells: spread evenly (the worst case for
  // aggregates), or Pareto, where about 20% of products take 80% of sales.
  const productIndex = distribution === "pareto"
    ? `floor(${products} * power(((hashint8(o * 2 + l) & 2147483647)::float / 2147483648), 7))::bigint`
    : `((o * 31 + l * 17) % ${products})`;
  const shop = (await client.query("insert into public.shops (shopify_shop_id, myshopify_domain, name) values (424242, $1, 'Capacity Fixture') returning shop_key", [domain])).rows[0].shop_key;
  const P = 1_000_000_000; // product ids
  const V = 2_000_000_000; // variant ids
  const I = 3_000_000_000; // inventory item ids
  const C = 4_000_000_000; // customer ids
  const O = 5_000_000_000; // order ids
  const L = 6_000_000_000; // line item ids
  const span = `${months} * 30 * 86400`;
  const text = "Soft breathable organic cotton with a relaxed fit, made to last through every wash and every season. ";
  const steps = [
    [`insert into public.products (shop_key, shopify_id, title, handle, status, product_type, vendor, category, tags, description_excerpt, published_at, shopify_created_at, shopify_updated_at)
      select $1, ${P} + i, initcap(substr(repeat('everyday heavyweight organic cotton tee relaxed linen shirt ', 3), 1 + i % 20, 25 + i % 41)),
             'product-' || i || '-' || substr(md5(i::text), 1, 10),
             case when i % 20 = 0 then 'archived' when i % 50 = 0 then 'draft' else 'active' end,
             (array['Apparel','Accessories','Home & Garden','Beauty','Electronics'])[1 + i % 5], 'Vendor ' || (i % 40),
             'Apparel & Accessories > Clothing > ' || (array['Shirts','Dresses','Shoes','Bags'])[1 + i % 4],
             (array['summer','new','cotton','sale','bestseller'])[1:1 + i % 5],
             substr(repeat($2, 10), 1, 150 + i % 451),
             now() - make_interval(days => i % 900), now() - make_interval(days => i % 1000), now() - make_interval(days => i % 30)
        from generate_series(1, ${products}) i`, [shop, text]],
    [`insert into public.product_variants (shop_key, shopify_id, product_shopify_id, title, sku, position, selected_options, price, compare_at_price, taxable,
        inventory_item_id, tracked, inventory_policy, inventory_quantity, requires_shipping, weight, weight_unit, unit_cost, unit_cost_currency, country_of_origin, shopify_created_at, shopify_updated_at)
      select $1, ${V} + (p - 1) * 3 + v, ${P} + p, (array['Small','Medium','Large'])[v], 'SKU-' || p || '-' || v, v,
             jsonb_build_array(jsonb_build_object('name', 'Size', 'value', (array['Small','Medium','Large'])[v])),
             19.99 + p % 80, case when p % 3 = 0 then 29.99 + p % 80 end, true, ${I} + (p - 1) * 3 + v, true, 'deny', (p * 7 + v) % 120 - 5, true,
             0.25 + v * 0.1, 'kilograms', case when p % 4 <> 0 then 6.5 + p % 30 end, case when p % 4 <> 0 then 'USD' end, 'CN',
             now() - make_interval(days => p % 1000), now() - make_interval(days => p % 30)
        from generate_series(1, ${products}) p, generate_series(1, 3) v`, [shop]],
    [`insert into public.inventory_locations (shop_key, shopify_id, name, country_code, province_code, fulfills_online_orders)
      select $1, 7000 + l, (array['Main warehouse','Retail store','3PL partner'])[l], 'US', (array['CA','NY','TX'])[l], true from generate_series(1, 3) l`, [shop]],
    [`insert into public.inventory_levels (shop_key, inventory_item_id, location_shopify_id, available, on_hand, shopify_updated_at)
      select $1, ${I} + n, 7000 + l, (n * 13 + l) % 90, (n * 13 + l) % 90 + 2, now() - make_interval(days => n % 30)
        from generate_series(1, ${products * 3}) n, generate_series(1, 2) l`, [shop]],
    [`insert into public.customers (shop_key, shopify_id, country_code, orders_count, amount_spent, amount_spent_currency, first_order_at, first_order_shopify_id,
        first_order_product_shopify_ids, shopify_created_at, shopify_updated_at)
      select $1, ${C} + c, (array['US','GB','CA','AU','NG'])[1 + c % 5], 1 + c % 4, 50 + c % 500, 'USD',
             now() - make_interval(secs => ((c::float / ${s.customers}) * ${span})::bigint), ${O} + c,
             case when c % 3 = 0 then array[${P} + 1 + c % ${products}, ${P} + 1 + (c * 7) % ${products}] else array[${P} + 1 + c % ${products}] end,
             now() - make_interval(days => c % 1095), now() - make_interval(days => c % 60)
        from generate_series(1, ${s.customers}) c`, [shop]],
    [`insert into public.orders (shop_key, shopify_id, name, shopify_created_at, processed_at, financial_status, fulfillment_status, currency, presentment_currency,
        subtotal, total_discounts, total_tax, total_shipping, total_price, total_refunded, customer_shopify_id,
        ship_country_code, ship_province_code, ship_city_raw, ship_city, source_name, shopify_updated_at)
      select $1, ${O} + o, '#' || (1000 + o), t, t, case when o % 33 = 0 then 'partially_refunded' else 'paid' end, 'fulfilled', 'USD', null,
             40 + o % 200, (o % 7) * 2.5, 3.2 + o % 9, 4.99, 48.19 + o % 200, case when o % 33 = 0 then 20 else 0 end,
             case when o % 20 = 0 then null else ${C} + 1 + o % ${s.customers} end,
             (array['US','GB','CA','AU','NG'])[1 + o % 5], (array['CA','NY','TX','ON','NSW','LA'])[1 + o % 6],
             null,
             (array['Los Angeles','New York','Austin','Toronto','Sydney','Lagos','Manchester'])[1 + o % 7], 'web', t + interval '2 days'
        from generate_series(1, ${orders}) o, lateral (select now() - make_interval(secs => ((1 - o::float / ${orders}) * ${span})::bigint) as t) x`, [shop]],
    [`insert into public.order_line_items (shop_key, shopify_id, order_shopify_id, product_shopify_id, variant_shopify_id, title, sku, quantity, current_quantity,
        refunded_quantity, unit_price, total_discount)
      select $1, ${L} + o * 2 + l, ${O} + o, ${P} + 1 + p.pi, ${V} + p.pi * 3 + 1 + l % 3,
             initcap(substr(repeat('everyday heavyweight organic cotton tee relaxed linen shirt ', 3), 1 + o % 20, 25 + o % 41)),
             'SKU-' || (1 + p.pi) || '-' || (1 + l % 3), 1 + o % 3, 1 + o % 3, case when o % 33 = 0 and l = 1 then 1 else 0 end,
             19.99 + o % 80, (o % 7) * 1.25
        from generate_series(1, ${orders}) o, lateral generate_series(1, case when o % 2 = 0 then 2 else 1 end) l,
             lateral (select ${productIndex} as pi) p`, [shop]],
    [`insert into public.refunds (shop_key, shopify_id, order_shopify_id, shopify_created_at, total_refunded, currency)
      select $1, 8000000000 + o, ${O} + o, now() - make_interval(secs => ((1 - o::float / ${orders}) * ${span})::bigint) + interval '9 days', 20, 'USD'
        from generate_series(33, ${orders}, 33) o`, [shop]],
    [`insert into public.returns (shop_key, shopify_id, order_shopify_id, name, status, total_quantity, shopify_created_at, closed_at)
      select $1, 9000000000 + o, ${O} + o, '#R' || o, 'closed', 1 + o % 2, now() - make_interval(secs => ((1 - o::float / ${orders}) * ${span})::bigint) + interval '12 days',
             now() - make_interval(secs => ((1 - o::float / ${orders}) * ${span})::bigint) + interval '20 days'
        from generate_series(50, ${orders}, 50) o`, [shop]],
    [`insert into public.return_line_items (shop_key, shopify_id, return_shopify_id, line_item_shopify_id, quantity, return_reason)
      select $1, 9500000000 + o * 2 + r, 9000000000 + o, ${L} + o * 2 + r, 1, (array['size_too_small','defective','not_as_described','unwanted'])[1 + o % 4]
        from generate_series(50, ${orders}, 50) o, lateral generate_series(1, case when o % 250 = 0 then 2 else 1 end) r`, [shop]],
    [`insert into public.metafields (shop_key, owner_type, owner_shopify_id, namespace, key, type, value_excerpt, shopify_updated_at)
      select $1, 'product', ${P} + p, 'custom', (array['material','care','fit'])[k], 'single_line_text_field', substr(repeat($2, 3), 1, 30 + (p * k) % 170), now()
        from generate_series(1, ${products}) p, generate_series(1, 3) k`, [shop, text]],
    [`insert into public.metaobject_definitions (shop_key, shopify_id, type, name, field_definitions)
      select $1, 10000 + d, (array['material','size_chart','care_guide','designer','collection_story'])[d], 'Definition ' || d,
             jsonb_build_array(jsonb_build_object('key','name','type','single_line_text_field'), jsonb_build_object('key','description','type','multi_line_text_field'))
        from generate_series(1, 5) d`, [shop]],
    [`insert into public.metaobjects (shop_key, shopify_id, type, handle, display_name, fields, shopify_updated_at)
      select $1, 20000 + m, (array['material','size_chart','care_guide','designer','collection_story'])[1 + m % 5], 'entry-' || m, 'Entry ' || m,
             jsonb_build_object('name', 'Entry ' || m, 'description', substr(repeat($2, 3), 1, 120 + m % 180), 'origin', 'Portugal', 'weight_gsm', 180 + m % 120), now()
        from generate_series(1, ${s.metaobjects}) m`, [shop, text]],
    [`insert into public.shop_settings (shop_key, currency, timezone, country_code, primary_locale, enabled_locales, shopify_plan, markets, delivery_summary, policies)
      values ($1, 'USD', 'America/Los_Angeles', 'US', 'en', '{en,fr}', 'Shopify',
              (select jsonb_agg(jsonb_build_object('name', 'Market ' || m, 'status', 'ACTIVE', 'countries', jsonb_build_array('US','CA'))) from generate_series(1, 6) m),
              jsonb_build_object('zones', 4, 'free_shipping_threshold', 75), jsonb_build_object('refund', substr(repeat($2, 10), 1, 800)))`, [shop, text]],
    [`insert into public.shop_access (shop_key, granted_scopes, domains, withheld_fields)
      values ($1, '{read_products,read_orders,read_all_orders,read_customers,read_inventory,read_locations,read_returns,read_metaobjects}',
              jsonb_build_object('catalog', jsonb_build_object('status','available'), 'orders', jsonb_build_object('status','available'), 'customers', jsonb_build_object('status','partial','reason','level_2_fields_withheld')),
              jsonb_build_object('Customer.email', jsonb_build_object('domain','customers','reason','ACCESS_DENIED')))`, [shop]],
    [`insert into public.sync_runs (shop_key, domain, kind, status, rows_written, counts, started_at, finished_at, created_at)
      select $1, (array['catalog','orders','customers','inventory','returns','custom_data','settings'])[1 + r % 7], case when r <= 7 then 'initial' else 'reconcile' end,
             'succeeded', 1000 * r, jsonb_build_object('rows', 1000 * r), now() - make_interval(days => 60 - r), now() - make_interval(days => 60 - r) + interval '5 minutes', now() - make_interval(days => 60 - r)
        from generate_series(1, 60) r`, [shop]],
    [`insert into public.sync_checkpoints (shop_key, domain, committed_line, watermark)
      select $1, d, 1000, now() from unnest(array['catalog','orders','customers','inventory','returns','custom_data','settings']) d`, [shop]],
    // Thirty days of handled order webhooks (create, paid, updated); handled rows keep no payload.
    [`insert into public.webhook_events (shop_domain, shop_key, webhook_id, topic, triggered_at, received_at, status, attempts, processed_at)
      select $2, $1, md5(w::text), (array['orders/create','orders/paid','orders/updated'])[1 + w % 3], now() - make_interval(secs => w % 2592000),
             now() - make_interval(secs => w % 2592000), 'processed', 1, now() - make_interval(secs => w % 2592000)
        from generate_series(1, ${Math.ceil((orders / months) * 3)}) w`, [shop, domain]],
    [`insert into public.product_metrics (shop_key, product_shopify_id, window_days, calc_version, window_end, currency, orders, units, gross_sales, discounts, net_sales, customers, first_time_customers)
      select $1, li.product_shopify_id, w, 1, now(), 'USD', count(distinct o.shopify_id), sum(li.quantity), sum(li.unit_price * li.quantity), sum(li.total_discount),
             sum(li.unit_price * li.quantity) - sum(li.total_discount), count(distinct o.customer_shopify_id), 0
        from public.order_line_items li join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id, unnest(array[7, 30, 90, 365]) w
       where li.shop_key = $1 and li.product_shopify_id is not null and o.processed_at > now() - make_interval(days => w)
       group by li.product_shopify_id, w`, [shop]],
    [`insert into public.store_metrics (shop_key, window_days, calc_version, window_end, currency, orders, units, gross_sales, net_sales, customers, new_customers, returning_customers)
      select $1, w, 1, now(), 'USD', w * 10, w * 15, w * 600, w * 560, w * 8, w * 5, w * 3 from unnest(array[7, 14, 30, 60, 90, 180, 365]) w`, [shop]],
  ];
  for (const [sql, params] of steps) await client.query(sql, params);
  return { shop, domain };
}

/** Bytes per table, split into heap, indexes and TOAST, with row counts. */
export async function measure(client) {
  const tables = (await client.query(`
    select c.relname as table, c.reltuples::bigint as rows, pg_relation_size(c.oid) as heap, pg_indexes_size(c.oid) as indexes,
           coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0) as toast, pg_total_relation_size(c.oid) as total
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname = any($1) order by total desc`, [MIRROR])).rows
    .map((r) => ({ table: r.table, rows: Math.max(0, Number(r.rows)), heap: Number(r.heap), indexes: Number(r.indexes), toast: Number(r.toast), total: Number(r.total) }));
  const database = Number((await client.query("select pg_database_size(current_database()) as b")).rows[0].b);
  return { database, mirror: tables.reduce((sum, t) => sum + t.total, 0), tables };
}

async function timed(client, sql, params) {
  const started = process.hrtime.bigint();
  await client.query(sql, params);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** Indicative only: local hardware, warm cache. */
async function queries(client, shop) {
  const q = {
    "Top products by units, last 30 days": [`select li.product_shopify_id, sum(li.quantity) from public.orders o join public.order_line_items li on li.shop_key = o.shop_key and li.order_shopify_id = o.shopify_id
      where o.shop_key = $1 and o.processed_at > now() - interval '30 days' group by 1 order by 2 desc limit 50`, [shop]],
    "Repeat-customer rate, last 12 months": [`select count(*) filter (where n > 1)::float / greatest(count(*), 1) from (select customer_shopify_id, count(*) n from public.orders
      where shop_key = $1 and processed_at > now() - interval '365 days' and customer_shopify_id is not null group by 1) s`, [shop]],
    "One product's 365-day sales": [`select sum(li.quantity), sum(li.unit_price * li.quantity) from public.order_line_items li join public.orders o on o.shop_key = li.shop_key and o.shopify_id = li.order_shopify_id
      where li.shop_key = $1 and li.product_shopify_id = 1000000007 and o.processed_at > now() - interval '365 days'`, [shop]],
    "One product's metrics row": ["select * from public.product_metrics where shop_key = $1 and product_shopify_id = 1000000007 and window_days = 30 and calc_version = 1", [shop]],
  };
  const out = {};
  for (const [name, [sql, params]] of Object.entries(q)) {
    await client.query(sql, params);
    out[name] = Math.round(await timed(client, sql, params) * 10) / 10;
  }
  return out;
}

/** Deleting the whole shop, as shop/redact does, inside a transaction that is rolled back. */
async function deletion(client, domain) {
  await client.query("begin");
  try {
    const ms = await timed(client, "select public.delete_shop_synced_data($1)", [domain]);
    const left = Number((await client.query("select public.shop_synced_row_count($1) as n", [domain])).rows[0].n);
    return { ms: Math.round(ms), rows_left: left };
  } finally {
    await client.query("rollback");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL (a local server) is required."); process.exit(2); }
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) { console.error("Refusing: capacity fixtures run only against a local Postgres."); process.exit(2); }
  const profiles = (value("--profiles") ?? "small,medium,large,xlarge").split(",");
  for (const p of profiles) if (!PROFILES[p]) { console.error(`Unknown profile ${p}`); process.exit(2); }
  const months = Number(value("--months") ?? 36);
  const keep = args.includes("--keep");

  const dbUrl = (name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };
  const root = new pg.Client({ connectionString: url });
  await root.connect();
  const report = { generated_at: new Date().toISOString(), server: (await root.query("select current_setting('server_version') v")).rows[0].v, months, empty: null, profiles: {} };
  try {
    await root.query("drop database if exists cap_template");
    await root.query("create database cap_template");
    const provision = spawnSync(process.execPath, ["supabase/provision.mjs"], { env: { ...process.env, DATABASE_URL: dbUrl("cap_template") }, encoding: "utf8" });
    if (provision.status !== 0) throw new Error(`provision failed: ${provision.stderr || provision.stdout}`);
    {
      const c = new pg.Client({ connectionString: dbUrl("cap_template") });
      await c.connect();
      await c.query("vacuum analyze");
      report.empty = await measure(c);
      await c.end();
    }
    for (const name of profiles) {
      const db = `cap_${name}`;
      await root.query(`drop database if exists ${db}`);
      await root.query(`create database ${db} template cap_template`);
      const c = new pg.Client({ connectionString: dbUrl(db) });
      await c.connect();
      try {
        const started = Date.now();
        const { shop, domain } = await loadShop(c, { ...PROFILES[name], months });
        const loadSeconds = Math.round((Date.now() - started) / 1000);
        await c.query("vacuum analyze");
        const sizes = await measure(c);
        report.profiles[name] = {
          ...PROFILES[name], shape: shape(PROFILES[name]), load_seconds: loadSeconds, ...sizes,
          database_growth: sizes.database - report.empty.database,
          queries_ms: await queries(c, shop), deletion: await deletion(c, domain),
        };
        console.log(`${name}: mirror ${(sizes.mirror / 1048576).toFixed(1)} MB, database +${((sizes.database - report.empty.database) / 1048576).toFixed(1)} MB (load ${loadSeconds}s)`);
      } finally {
        await c.end();
        if (!keep) await root.query(`drop database if exists ${db}`);
      }
    }
  } finally {
    if (!keep) await root.query("drop database if exists cap_template");
    await root.end();
  }
  const out = value("--out");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
