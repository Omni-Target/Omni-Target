/**
 * Real Postgres tests for shop context (Phase 3, task 5; migration 0048):
 * settings and context saved together for an ingestible shop, read back with
 * the shop's locations and granted scopes, shops due for a refresh, bounds,
 * and access. Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 6 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
async function as(role, sql, params) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
const call = async (fn, ...args) => (await as("service_role", `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args))[0].result;
const json = (value) => JSON.stringify(value);

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function boundShop() {
  const shop = `x-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, key };
}
const settings = (extra = {}) => ({
  fields_version: 1, name: "Shop", primary_domain: "shop.example", currency: "GBP", money_format: "£{{amount}}", timezone: "Europe/London",
  country_code: "GB", primary_locale: "en", enabled_locales: ["en"], shopify_plan: "Basic", shopify_plus: false, partner_development: true,
  weight_unit: "kilograms", taxes_included: true, logo_url: "https://cdn.shopify.com/logo.png",
  markets: [{ id: "gid://shopify/Market/1", name: "UK", status: "ACTIVE", countries: ["GB"] }],
  delivery_summary: { zones: [{ zone_name: "Domestic", countries: ["GB"] }] },
  policies: { items: [{ type: "REFUND_POLICY", title: "Refunds", url: "https://shop.example/r", body: "30 days", truncated: false }] }, ...extra,
});
const context = (extra = {}) => ({
  fields_version: 1, capabilities: { markets: { status: "available", required_scopes: ["read_markets"] } }, analytics: { source: "shopifyql", sessions: 10 },
  discounts: [{ id: "d1", title: "WELCOME", summary: "10% off", status: "ACTIVE" }], marketing: [], locales: [{ locale: "en", primary: true, published: true }],
  warnings: ["one"], ...extra,
});

describe("shop context (0048)", () => {
  it("saves settings and context together, and reads them back with locations and granted scopes", async () => {
    const s = await boundShop();
    await call("ingest_inventory", s.key, json([{ shopify_id: 9, name: "Warehouse", country_code: "GB", is_active: true, fulfills_online_orders: true, has_active_inventory: true }]), "[]", null);
    await q("insert into public.shop_access (shop_key, granted_scopes) values ($1, $2)", [s.key, ["read_products", "read_markets"]]);
    expect(await call("save_shop_context", s.key, json(settings()), json(context()))).toEqual({ saved: true });
    const read = await call("insight_shop_context", s.key);
    expect(read).toMatchObject({ myshopify_domain: s.shop, granted_scopes: ["read_products", "read_markets"],
      locations: [{ id: 9, name: "Warehouse", fulfills_online_orders: true, has_active_inventory: true, is_active: true }] });
    expect(read.settings).toMatchObject({ name: "Shop", currency: "GBP", country_code: "GB", markets: settings().markets, logo_url: "https://cdn.shopify.com/logo.png" });
    expect(read.context).toMatchObject({ analytics: { sessions: 10 }, discounts: context().discounts, warnings: ["one"] });

    // A later read without a logo keeps the last one found; everything else is replaced.
    await call("save_shop_context", s.key, json(settings({ logo_url: null, name: "Renamed", markets: [] })), json(context({ discounts: [], analytics: null })));
    const again = await call("insight_shop_context", s.key);
    expect(again.settings).toMatchObject({ name: "Renamed", markets: [], logo_url: "https://cdn.shopify.com/logo.png" });
    expect(again.context).toMatchObject({ discounts: [], analytics: null });
  });

  it("refuses data beyond the bounds, and a shop that is not ingestible", async () => {
    const s = await boundShop();
    await expect(call("save_shop_context", s.key, json(settings({ currency: "pounds" })), json(context()))).rejects.toThrow(/currency/);
    await expect(call("save_shop_context", s.key, json(settings()), json(context({ warnings: Array.from({ length: 21 }, (_, i) => `w${i}`) })))).rejects.toThrow(/warnings/);
    const big = Array.from({ length: 400 }, (_, i) => ({ id: `d${i}-${"x".repeat(60)}`, title: `${i}-${"t".repeat(120)}`, summary: `${i}-${"s".repeat(300)}`, status: "ACTIVE" }));
    await expect(call("save_shop_context", s.key, json(settings()), json(context({ discounts: big })))).rejects.toThrow(/discounts/);
    const unbound = (await one("select coalesce(max(shop_key), 0) + 1000 as k from public.shops")).k;
    await expect(call("save_shop_context", unbound, json(settings()), json(context()))).rejects.toThrow(/not_ingestible/);
  });

  it("lists only imported shops whose context is missing or older than the age given", async () => {
    const s = await boundShop();
    const due = async () => (await as("service_role", "select shop_domain from public.shops_context_due($1, 1000)", [3600])).map((r) => r.shop_domain);
    // Never imported: not due, as for the insights schedule.
    expect((await one("select public.summary_maintenance_ready($1) as r", [s.key])).r).toBe(false);
    expect(await due()).not.toContain(s.shop);
  });

  it("is reachable by the service role only, and the service role cannot write the context directly", async () => {
    const s = await boundShop();
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.insight_shop_context($1)", [s.key])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select * from public.shop_context")).rejects.toThrow(/permission denied/);
    }
    await expect(as("service_role", "insert into public.shop_context (shop_key, fields_version) values ($1, 1)", [s.key])).rejects.toThrow(/permission denied/);
  });
});
