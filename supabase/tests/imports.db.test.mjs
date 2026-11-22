/**
 * Real Postgres tests for the initial import workflow's database side (Phase
 * 2, task 6; migration 0034). Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 10 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
async function call(fn, ...args) {
  const client = await pool.connect();
  try {
    await client.query("set role service_role");
    return (await client.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args)).rows[0].result;
  } finally {
    await client.query("reset role");
    client.release();
  }
}
const json = (fn, ...args) => call(fn, ...args.map((a) => (Array.isArray(a) ? JSON.stringify(a) : a)));

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;
const KEY = randomBytes(32);
const digestHex = (shopify, type, id) => createHmac("sha256", KEY).update(`${shopify}:${type}:${id}`).digest("hex");
async function boundShop() {
  const shop = `imp-${tag()}.myshopify.com`;
  const shopify = Math.floor(Math.random() * 9e12) + 1e12;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test') as r", [shopify, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key };
}
const windowStart = async () => new Date((await one("select public.retention_window_start() as t")).t);
const monthBefore = (start, months, day = 5) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - months, day));

describe("import records and dispatch (task 6)", () => {
  it("keeps one active import per shop, and refuses a shop that cannot be imported", async () => {
    const s = await boundShop();
    const first = await call("request_shop_import", s.key);
    expect(first).toMatchObject({ outcome: "requested", dispatch_attempts: 0 });
    expect(await call("request_shop_import", s.key)).toMatchObject({ outcome: "existing", import_id: first.import_id });
    const { shop_key: unbound } = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning shop_key", [Date.now(), `u-${tag()}.myshopify.com`]);
    expect(await call("request_shop_import", unbound)).toEqual({ outcome: "not_ingestible" });
  });

  it("lets one run work: a second is busy, a stale run is taken over and loses its heartbeat, and a finished import is never run again", async () => {
    const s = await boundShop();
    const { import_id: id } = await call("request_shop_import", s.key);
    expect(await call("mark_import_dispatched", id, "run_a")).toEqual({ outcome: "dispatched" });
    expect(await call("claim_shop_import", id, "run_a", 900)).toMatchObject({ outcome: "claimed", shop_key: s.key, shop_domain: s.shop });
    expect(await call("claim_shop_import", id, "run_b", 900)).toEqual({ outcome: "busy" });
    await q("update public.shop_imports set heartbeat_at = now() - interval '20 minutes' where id = $1", [id]);
    expect(await call("claim_shop_import", id, "run_b", 900)).toMatchObject({ outcome: "claimed" });
    expect(await call("import_heartbeat", id, "run_a", null)).toEqual({ outcome: "lost" });
    expect(await call("finish_shop_import", id, "run_a", "succeeded", null, null)).toEqual({ outcome: "not_active" });
    expect(await call("finish_shop_import", id, "run_b", "succeeded", { ok: true }, null)).toEqual({ outcome: "finished" });
    expect(await call("claim_shop_import", id, "run_c", 900)).toEqual({ outcome: "finished", status: "succeeded" });
    expect((await call("request_shop_import", s.key)).outcome).toBe("requested");
  });

  it("lists imports whose dispatch failed or whose run went quiet, for the reconcile job", async () => {
    const s = await boundShop();
    const { import_id: id } = await call("request_shop_import", s.key);
    const due = async () => (await q("select import_id from public.imports_needing_dispatch(120, 900, 200)")).map((r) => r.import_id);
    expect(await due()).not.toContain(id);
    await q("update public.shop_imports set requested_at = now() - interval '5 minutes' where id = $1", [id]);
    expect(await due()).toContain(id);
    await call("mark_import_dispatched", id, "run_x");
    await call("claim_shop_import", id, "run_x", 900);
    expect(await due()).not.toContain(id);
    await q("update public.shop_imports set heartbeat_at = now() - interval '30 minutes' where id = $1", [id]);
    expect(await due()).toContain(id);
  });
});

describe("history beyond the window (decision 3)", () => {
  it("stages only orders before the window, without suppressed customers, idempotently, and summarises whole months into final rows", async () => {
    const s = await boundShop();
    const start = await windowStart();
    const { import_id: id } = await call("request_shop_import", s.key);
    await expect(json("stage_history_orders", id, "run_h", [], [])).rejects.toThrow(/import_not_running/);
    await call("claim_shop_import", id, "run_h", 900);
    // customers/redact named customer 502.
    await call("record_customer_compliance", "customers/redact", s.shopify, s.shop, randomUUID(), new Date(), 502, null,
      Buffer.from(digestHex(s.shopify, "customer", 502), "hex"), null, 1);

    const m3 = monthBefore(start, 3);
    const m2 = monthBefore(start, 2);
    const order = (id, at, customer, extra = {}) => ({
      shopify_id: id, processed_at: at.toISOString(), currency: "GBP", total_price: "30.00", subtotal: "25.00",
      customer_digest: customer ? digestHex(s.shopify, "customer", customer) : null, order_digest: digestHex(s.shopify, "order", id), ...extra,
    });
    const orders = [
      order(1, m3, 501), order(2, m2, 501), order(3, m2, 502), order(4, m2, null), order(5, m2, 503, { is_test: true }),
      order(6, new Date(start.getTime() + 86_400_000), 504),
    ];
    const lines = [
      { shopify_id: 11, order_shopify_id: 1, product_shopify_id: 10, quantity: 1, unit_price: "25.00" },
      { shopify_id: 21, order_shopify_id: 2, product_shopify_id: 10, quantity: 2, unit_price: "12.50", total_discount: "1.00" },
      { shopify_id: 31, order_shopify_id: 3, product_shopify_id: 20, quantity: 1, unit_price: "25.00", refunded_quantity: 1 },
      { shopify_id: 41, order_shopify_id: 4, product_shopify_id: 10, quantity: 1, unit_price: "25.00" },
      { shopify_id: 61, order_shopify_id: 6, product_shopify_id: 10, quantity: 1, unit_price: "25.00" },
    ];
    expect(await json("stage_history_orders", id, "run_h", orders, lines)).toEqual({ orders: 5, lines: 4, in_window: 1, suppressed: 1, customers: 0 });
    expect(await json("stage_history_orders", id, "run_h", orders, lines)).toMatchObject({ orders: 0, lines: 0 });
    expect(await one("select count(*)::int as n from public.history_stage_orders where import_id = $1 and order_shopify_id = 3 and customer_digest is null", [id])).toEqual({ n: 1 });
    expect((await q("select month::text, orders::int from public.history_stage_months($1)", [id])).map((r) => r.orders)).toEqual([1, 4]);

    const iso = (d) => d.toISOString().slice(0, 10).replace(/-\d\d$/, "-01");
    expect(await call("summarise_history_month", id, "run_h", iso(m2), 1)).toEqual({ product_months: 2, store_months: 1 });
    await call("summarise_history_month", id, "run_h", iso(m3), 1);
    expect(await q(
      `select month::text, product_shopify_id::int as product, orders, units, gross_sales::float8 as gross, discounts::float8 as discounts, refunded_units,
              customers, first_time_customers, finalized_at is not null as final
         from public.product_monthly_metrics where shop_key = $1 order by month, product`, [s.key]))
      .toEqual([
        { month: iso(m3), product: 10, orders: 1, units: 1, gross: 25, discounts: 0, refunded_units: 0, customers: 1, first_time_customers: 1, final: true },
        // Month 2: 501 returns (not first-time), 502 is suppressed (no customer), 4 is a guest, 5 is a test order.
        { month: iso(m2), product: 10, orders: 2, units: 3, gross: 50, discounts: 1, refunded_units: 0, customers: 1, first_time_customers: 0, final: true },
        { month: iso(m2), product: 20, orders: 1, units: 1, gross: 25, discounts: 0, refunded_units: 1, customers: 0, first_time_customers: 0, final: true },
      ]);
    expect(await one("select orders, customers, new_customers, total_price::float8 as total from public.store_monthly_metrics where shop_key = $1 and month = $2", [s.key, iso(m2)]))
      .toEqual({ orders: 3, customers: 1, new_customers: 0, total: 90 });
    // Final rows never change; a month inside the window is refused.
    expect(await call("summarise_history_month", id, "run_h", iso(m2), 1)).toEqual({ product_months: 0, store_months: 0 });
    await expect(call("summarise_history_month", id, "run_h", iso(start), 1)).rejects.toThrow(/month_inside_retained_window/);

    expect(await call("discard_history_stage", id, "run_h", 2)).toMatchObject({ deleted: 2 });
    while ((await call("discard_history_stage", id, "run_h", 2)).remaining > 0);
    expect(await one("select (select count(*) from public.history_stage_orders where import_id = $1)::int + (select count(*) from public.history_stage_lines where import_id = $1)::int as n", [id])).toEqual({ n: 0 });
  });

  it("keeps detailed orders from the start of the window's first month (month-aligned ingest_orders)", async () => {
    const s = await boundShop();
    const start = await windowStart();
    const early = new Date(start.getTime() + 2 * 3_600_000).toISOString();
    const before = new Date(start.getTime() - 3_600_000).toISOString();
    const o = (id, at) => ({ shopify_id: id, shopify_created_at: at, processed_at: at, currency: "GBP", total_price: "1.00", order_digest: digestHex(s.shopify, "order", id) });
    expect(await json("ingest_orders", s.key, [o(1, early), o(2, before)], [], [])).toMatchObject({ orders: 1, beyond_window: 1 });
  });
});

describe("scoped imports (0039)", () => {
  it("records the domains an import covers, returns them to the run, and refuses unknown ones", async () => {
    const s = await boundShop();
    const { import_id: id } = await call("request_shop_import", s.key, ["orders", "customers", "returns"]);
    expect(await one("select domains from public.shop_imports where id = $1", [id])).toEqual({ domains: ["orders", "customers", "returns"] });
    expect(await call("claim_shop_import", id, "run_scope", 900)).toMatchObject({ outcome: "claimed", domains: ["orders", "customers", "returns"] });
    // One active import per shop, whatever another request asks for.
    expect(await call("request_shop_import", s.key, ["catalog"])).toMatchObject({ outcome: "existing", import_id: id });
    await call("finish_shop_import", id, "run_scope", "succeeded", null, null);

    const { import_id: all } = await call("request_shop_import", s.key);
    expect(await call("claim_shop_import", all, "run_all", 900)).toMatchObject({ outcome: "claimed", domains: null });
    await call("finish_shop_import", all, "run_all", "succeeded", null, null);
    await expect(call("request_shop_import", s.key, ["orders", "payments"])).rejects.toThrow(/check constraint/);
  });
});
