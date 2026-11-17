/**
 * Real Postgres tests for the commerce mirror (Phase 1, task 8): migrations
 * 0024 (commerce model) and 0025 (sync runs, checkpoints, webhook inbox,
 * metrics). Synthetic rows only.
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

/** Statements as service_role, in one transaction, as the ingestion worker runs them. */
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
const dbNow = async () => (await one("select clock_timestamp()::text as t")).t;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const domain = () => `c-${tag()}.myshopify.com`;
const shopifyId = () => String(Math.floor(Math.random() * 9e12) + 1e12);
async function newShop(shop = domain()) {
  const shopify = shopifyId();
  const { id } = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning id", [shopify, shop]);
  return { id, shop, shopify };
}

/** Every table that mirrors or is derived from one shop's Shopify data. */
const SYNCED = [
  "products", "product_variants", "inventory_locations", "inventory_levels", "customers", "orders", "order_line_items",
  "refunds", "returns", "return_line_items", "metafields", "metaobject_definitions", "metaobjects", "shop_settings",
  "shop_access", "sync_runs", "sync_checkpoints", "webhook_events", "product_metrics", "store_metrics",
];
/** Tables that name a shop but hold ownership, billing, credentials or history, which redaction handles separately. */
const NOT_SYNCED = [
  "shop_bindings", "shop_credentials", "workspace_events", "ownership_transfers", "legacy_shop_claims",
  "credit_ledger", "provider_purchases", "purchase_intents", "billing_sync_state",
];

/** One row in every synced table for this shop, written as service_role. */
async function seed({ id, shop }) {
  await asService([
    ["insert into public.products (shop_id, shopify_id, title, status) values ($1, 10, 'Lamp', 'active')", [id]],
    ["insert into public.product_variants (shop_id, shopify_id, product_shopify_id, price, inventory_item_id) values ($1, 11, 10, 25, 12)", [id]],
    ["insert into public.inventory_locations (shop_id, shopify_id, name, country_code) values ($1, 13, 'Warehouse', 'GB')", [id]],
    ["insert into public.inventory_levels (shop_id, inventory_item_id, location_shopify_id, available) values ($1, 12, 13, 4)", [id]],
    ["insert into public.customers (shop_id, shopify_id, orders_count) values ($1, 14, 1)", [id]],
    ["insert into public.orders (shop_id, shopify_id, shopify_created_at, processed_at, currency, total_price, customer_shopify_id) values ($1, 15, now(), now(), 'GBP', 25, 14)", [id]],
    ["insert into public.order_line_items (shop_id, shopify_id, order_shopify_id, product_shopify_id, quantity, unit_price) values ($1, 16, 15, 10, 1, 25)", [id]],
    ["insert into public.refunds (shop_id, shopify_id, order_shopify_id, shopify_created_at, total_refunded, currency) values ($1, 17, 15, now(), 25, 'GBP')", [id]],
    ["insert into public.returns (shop_id, shopify_id, order_shopify_id, status) values ($1, 18, 15, 'closed')", [id]],
    ["insert into public.return_line_items (shop_id, shopify_id, return_shopify_id, line_item_shopify_id, quantity, return_reason) values ($1, 19, 18, 16, 1, 'defective')", [id]],
    ["insert into public.metafields (shop_id, owner_type, owner_shopify_id, namespace, key, type, value_excerpt) values ($1, 'product', 10, 'specs', 'wattage', 'number_integer', '40')", [id]],
    ["insert into public.metaobject_definitions (shop_id, shopify_id, type) values ($1, 20, 'material')", [id]],
    ["insert into public.metaobjects (shop_id, shopify_id, type, fields) values ($1, 21, 'material', '{\"name\": \"Brass\"}')", [id]],
    ["insert into public.shop_settings (shop_id, currency, timezone) values ($1, 'GBP', 'Europe/London')", [id]],
    ["insert into public.shop_access (shop_id, granted_scopes) values ($1, '{read_products}')", [id]],
    ["insert into public.sync_runs (shop_id, domain, kind) values ($1, 'catalog', 'initial')", [id]],
    ["insert into public.sync_checkpoints (shop_id, domain, committed_line) values ($1, 'catalog', 500)", [id]],
    ["insert into public.webhook_events (shop_domain, shop_id, webhook_id, topic, payload) values ($2, $1, $3, 'orders/paid', '{\"id\": 15}')", [id, shop, randomUUID()]],
    ["insert into public.product_metrics (shop_id, product_shopify_id, window_days, calc_version, window_end, currency, units) values ($1, 10, 30, 1, now(), 'GBP', 1)", [id]],
    ["insert into public.store_metrics (shop_id, window_days, calc_version, window_end, currency, orders) values ($1, 30, 1, now(), 'GBP', 1)", [id]],
  ]);
}
const syncedRows = async (shop) => Number((await one("select public.shop_synced_row_count($1) as n", [shop])).n);

describe("commerce mirror: access and shape", () => {
  it("classifies every shop-keyed table: each is synced (and deleted with the shop) or explicitly not", async () => {
    const rows = await q("select table_name from information_schema.columns where table_schema = 'public' and column_name = 'shop_id'");
    const tables = rows.map((row) => row.table_name).filter((name) => !NOT_SYNCED.includes(name)).sort();
    expect(tables).toEqual([...SYNCED].sort());
  });

  it("locks every synced table to service_role reads and writes, with RLS on, and keeps the deletion helpers internal", async () => {
    for (const table of SYNCED) {
      const row = await one(
        `select c.relrowsecurity as rls,
                has_table_privilege('service_role', c.oid, 'select,insert,update,delete') as rw,
                has_table_privilege('service_role', c.oid, 'truncate') as truncate,
                has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select') as public_read
           from pg_class c where c.oid = $1::regclass`, [`public.${table}`]);
      expect(row, table).toEqual({ rls: true, rw: true, truncate: false, public_read: false });
    }
    for (const fn of ["delete_shop_synced_data(text)", "shop_synced_row_count(text)"]) {
      const row = await one(
        `select has_function_privilege('service_role', $1, 'execute') as service, has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authed`, [`public.${fn}`]);
      expect(row, fn).toEqual({ service: false, anon: false, authed: false });
    }
  });

  it("keys rows by shop and Shopify ID: a replay updates in place and two shops never collide", async () => {
    const a = await newShop();
    const b = await newShop();
    const upsert = "insert into public.products (shop_id, shopify_id, title, status) values ($1, 99, $2, 'active') on conflict (shop_id, shopify_id) do update set title = excluded.title";
    await asService([[upsert, [a.id, "First"]], [upsert, [a.id, "Replayed"]], [upsert, [b.id, "Other shop"]]]);
    expect(await q("select shop_id, title from public.products where shopify_id = 99 and shop_id in ($1, $2) order by title", [a.id, b.id]))
      .toEqual([{ shop_id: b.id, title: "Other shop" }, { shop_id: a.id, title: "Replayed" }]);
  });

  it("removes children with their parent, refuses orphaned line items, and accepts a return before its order", async () => {
    const s = await newShop();
    await seed(s);
    await service("delete from public.products where shop_id = $1 and shopify_id = 10", [s.id]);
    expect((await one("select count(*)::int as n from public.product_variants where shop_id = $1", [s.id])).n).toBe(0);
    await service("delete from public.orders where shop_id = $1 and shopify_id = 15", [s.id]);
    expect(await one("select (select count(*)::int from public.order_line_items where shop_id = $1) as lines, (select count(*)::int from public.refunds where shop_id = $1) as refunds", [s.id]))
      .toEqual({ lines: 0, refunds: 0 });
    await expect(service("insert into public.order_line_items (shop_id, shopify_id, order_shopify_id, quantity, unit_price) values ($1, 50, 999, 1, 1)", [s.id]))
      .rejects.toThrow(/foreign key/);
    await service("insert into public.returns (shop_id, shopify_id, order_shopify_id, status) values ($1, 51, 777, 'requested')", [s.id]);
  });

  it("stores a new Shopify enumeration value but rejects malformed and oversized data", async () => {
    const s = await newShop();
    await service("insert into public.products (shop_id, shopify_id, title, status) values ($1, 1, 'Future', 'some_future_status')", [s.id]);
    await service("insert into public.products (shop_id, shopify_id, title, status) values ($1, 7, 'Parent', 'active')", [s.id]);
    const rejected = [
      ["insert into public.products (shop_id, shopify_id, title, status) values ($1, 2, 'Upper case', 'ACTIVE')", [s.id]],
      ["insert into public.products (shop_id, shopify_id, title, status, tags) values ($1, 3, 'Too many tags', 'active', $2)", [s.id, Array.from({ length: 251 }, (_, i) => `t${i}`)]],
      ["insert into public.metaobjects (shop_id, shopify_id, type, fields) values ($1, 4, 'big', $2)", [s.id, { blob: "x".repeat(9000) }]],
      ["insert into public.orders (shop_id, shopify_id, shopify_created_at, processed_at, currency, total_price) values ($1, 5, now(), now(), 'gbp', 1)", [s.id]],
      ["insert into public.orders (shop_id, shopify_id, shopify_created_at, processed_at, currency, total_price, ship_country_code) values ($1, 6, now(), now(), 'GBP', 1, 'United Kingdom')", [s.id]],
      ["insert into public.product_variants (shop_id, shopify_id, product_shopify_id, price, unit_cost) values ($1, 8, 7, 1, 1)", [s.id]],
    ];
    for (const [sql, params] of rejected) {
      await expect(service(sql, params), sql).rejects.toThrow(/check constraint/);
    }
  });

  it("holds no customer personal data, and accepts orders whose customer and destination Shopify withheld", async () => {
    const columns = (await q("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'customers'")).map((row) => row.column_name);
    expect(columns.filter((name) => /email|phone|name|address|zip|city/.test(name))).toEqual([]);
    const s = await newShop();
    await service("insert into public.orders (shop_id, shopify_id, shopify_created_at, processed_at, currency, total_price) values ($1, 1, now(), now(), 'USD', 10)", [s.id]);
    expect(await one("select customer_shopify_id, ship_country_code, ship_city from public.orders where shop_id = $1", [s.id]))
      .toEqual({ customer_shopify_id: null, ship_country_code: null, ship_city: null });
  });
});

describe("sync runs and the webhook inbox", () => {
  it("allows one queued or running full import per shop and domain, alongside incremental runs", async () => {
    const s = await newShop();
    const run = (kind, dataDomain = "orders") =>
      service("insert into public.sync_runs (shop_id, domain, kind) values ($1, $2, $3) returning id", [s.id, dataDomain, kind]);
    const [first] = await run("initial");
    await expect(run("full")).rejects.toThrow(/sync_runs_one_full_idx/);
    await run("incremental");
    await run("full", "catalog");
    await expect(service("update public.sync_runs set status = 'succeeded' where id = $1", [first.id])).rejects.toThrow(/check constraint/);
    await service("update public.sync_runs set status = 'succeeded', started_at = now(), finished_at = now() where id = $1", [first.id]);
    await run("full");
  });

  it("records each delivery once and keeps its payload only until it is handled", async () => {
    const s = await newShop();
    const webhook = randomUUID();
    const record = () => service(
      "insert into public.webhook_events (shop_domain, shop_id, webhook_id, topic, payload) values ($1, $2, $3, 'orders/paid', '{\"id\": 1}') on conflict (shop_domain, webhook_id) do nothing returning id",
      [s.shop, s.id, webhook]);
    const [first] = await record();
    expect(await record()).toEqual([]);
    await expect(service("update public.webhook_events set status = 'processed', processed_at = now() where id = $1", [first.id])).rejects.toThrow(/check constraint/);
    await service("update public.webhook_events set status = 'processed', processed_at = now(), payload = null where id = $1", [first.id]);
    const [dead] = await service(
      "insert into public.webhook_events (shop_domain, webhook_id, topic, payload, status, attempts) values ($1, $2, 'orders/paid', '{\"id\": 2}', 'dead', 8) returning payload",
      [s.shop, randomUUID()]);
    expect(dead.payload).toEqual({ id: 2 });
    await expect(service("insert into public.webhook_events (shop_domain, webhook_id, topic, payload) values ($1, $2, 'orders/paid', $3)", [s.shop, randomUUID(), { blob: "x".repeat(600_000) }]))
      .rejects.toThrow(/check constraint/);
  });
});

describe("shop/redact deletes the shop's mirrored data", () => {
  it("deletes every synced row of a bound shop, verifies none is left, and leaves other shops alone", async () => {
    const actor = `user_commerce_${tag()}`;
    const shop = domain();
    const shopify = shopifyId();
    const installed = (await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop') as r", [shopify, shop, actor])).r;
    const s = { shop, id: (await one("select id from public.shops where myshopify_domain = $1", [shop])).id };
    const other = await newShop();
    await seed(s);
    await seed(other);
    expect(await syncedRows(shop)).toBe(SYNCED.length);

    await call("begin_uninstall", shopify, shop, randomUUID(), await dbNow());
    const started = await call("record_shop_redact", shopify, shop, randomUUID(), await dbNow());
    expect(started).toMatchObject({ outcome: "deletion_started", workspace_id: installed.workspace_id });
    const done = await call("process_workspace_deletion", started.deletion_id);
    expect(done).toMatchObject({ outcome: "completed", verification: { shop_synced_rows: 0 } });
    expect(await syncedRows(shop)).toBe(0);
    expect(await syncedRows(other.shop)).toBe(SYNCED.length);
  });

  it("deletes the mirror of a shop with no workspace, including inbox rows for a shop never modelled", async () => {
    const s = await newShop();
    await seed(s);
    const unmodelled = { shop: domain(), shopify: shopifyId() };
    await service("insert into public.webhook_events (shop_domain, webhook_id, topic) values ($1, $2, 'app/uninstalled')", [unmodelled.shop, randomUUID()]);
    expect(await syncedRows(unmodelled.shop)).toBe(1);

    for (const target of [s, unmodelled]) {
      const started = await call("record_shop_redact", target.shopify, target.shop, randomUUID(), await dbNow());
      expect(started.outcome).toBe("no_workspace");
      expect(await call("process_unbound_shop_redact", started.compliance_request_id)).toEqual({ outcome: "completed" });
      expect(await syncedRows(target.shop)).toBe(0);
    }
  });
});
