/**
 * Real Postgres tests for tracked campaigns and their results (Phase 4, task 7; migration 0055): saving and
 * updating campaigns for the shop's own products, daily results with their exchange rate, all-or-none saves,
 * isolation between shops and function-only access. Synthetic rows only; nothing is published or spent.
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
async function boundShop(currency = "NGN") {
  const shop = `t-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  await q("insert into public.shop_settings (shop_key, currency, timezone) values ($1, $2, 'Africa/Lagos')", [key, currency]);
  await q("insert into public.products (shop_key, shopify_id, title, status) values ($1, 1, 'Board', 'active'), ($1, 2, 'Wax', 'active')", [key]);
  return key;
}
const CAMPAIGN = { name: "Board test", platform: "meta", product_ids: [1], status: "active", currency: "USD", daily_budget: 20,
  authorised_budget: 280000, max_loss: 200000, started_on: "2026-11-01" };
const day = (d, patch = {}) => ({ day: d, spend: 20, conversions: 1, conversion_value: 80, clicks: 40, impressions: 2000, fx_to_shop: 1500,
  fx_source: "exchange_rate_cache 2026-11-01", fx_as_of: "2026-11-01T06:00:00Z", ...patch });

describe("tracked campaigns (0055)", () => {
  it("saves a campaign and its daily results with the exchange rate beside each day, and reads them back", async () => {
    const key = await boundShop();
    const id = await call("save_ad_campaign", key, json(CAMPAIGN), "user_owner");
    expect(await call("save_ad_campaign_results", key, id, json([day("2026-11-01"), day("2026-11-02", { conversions: 0, conversion_value: 0 })]), "user_owner"))
      .toEqual({ saved: 2 });
    // Saving a day again replaces it.
    await call("save_ad_campaign_results", key, id, json([day("2026-11-02", { conversions: 2, conversion_value: 160 })]), "user_owner");
    const [c] = await call("ad_campaigns_with_results", key, null);
    expect(c).toMatchObject({ id, name: "Board test", product_ids: [1], status: "active", currency: "USD", created_by: "user_owner" });
    expect(c.results.map((r) => [r.day, r.spend, r.conversions, r.fx_to_shop, r.fx_source, r.source, r.fx_from, r.fx_to, Date.parse(r.fx_as_of)])).toEqual([
      ["2026-11-01", 20, 1, 1500, "exchange_rate_cache 2026-11-01", "merchant_entered", "USD", "NGN", Date.parse("2026-11-01T06:00:00Z")],
      ["2026-11-02", 20, 2, 1500, "exchange_rate_cache 2026-11-01", "merchant_entered", "USD", "NGN", Date.parse("2026-11-01T06:00:00Z")],
    ]);
    expect(c.purpose).toBe("test");
    // Update: scaled and paused.
    await call("save_ad_campaign", key, json({ ...CAMPAIGN, id, status: "paused", daily_budget: 24, last_scaled_on: "2026-11-10" }), "user_owner");
    expect((await call("ad_campaigns_with_results", key, [id]))[0]).toMatchObject({ status: "paused", daily_budget: 24, last_scaled_on: "2026-11-10" });
  });

  it("refuses what would make the results untrustworthy, all or none", async () => {
    const key = await boundShop();
    const id = await call("save_ad_campaign", key, json(CAMPAIGN), "user_owner");
    const results = async () => (await call("ad_campaigns_with_results", key, [id]))[0].results.length;
    await expect(call("save_ad_campaign_results", key, id, json([day("2026-11-01"), day("2026-11-02", { spend: -1 })]), "u"))
      .rejects.toThrow(/check/);
    await expect(call("save_ad_campaign_results", key, id, json([day("2999-01-01")]), "u")).rejects.toThrow(/future/);
    await expect(call("save_ad_campaign_results", key, id, json([day("2026-11-01", { fx_to_shop: 0 })]), "u")).rejects.toThrow(/check/);
    await expect(call("save_ad_campaign_results", key, id, json([]), "u")).rejects.toThrow(/1 to 400/);
    await expect(call("save_ad_campaign_results", key, id, json([day("2026-11-01", { fx_as_of: null })]), "u")).rejects.toThrow(/time its exchange rate applied/);
    await expect(call("save_ad_campaign_results", key, id, json([day("2026-11-01", { fx_as_of: "2999-01-01T00:00:00Z" })]), "u")).rejects.toThrow(/time its exchange rate applied/);
    expect(await results()).toBe(0);
    // A campaign in the shop's own currency must use a rate of 1.
    const local = await call("save_ad_campaign", key, json({ ...CAMPAIGN, currency: "NGN" }), "u");
    await expect(call("save_ad_campaign_results", key, local, json([day("2026-11-01")]), "u")).rejects.toThrow(/rate of 1/);
    expect(await call("save_ad_campaign_results", key, local, json([day("2026-11-01", { fx_to_shop: 1, fx_source: "same currency" })]), "u")).toEqual({ saved: 1 });
    // Products and runs must be the shop's.
    await expect(call("save_ad_campaign", key, json({ ...CAMPAIGN, product_ids: [999] }), "u")).rejects.toThrow(/not the shop's/);
    await expect(call("save_ad_campaign", key, json({ ...CAMPAIGN, recommendation_run_id: "00000000-0000-0000-0000-000000000000" }), "u")).rejects.toThrow(/run is not/);
    await expect(call("save_ad_campaign", key, json({ ...CAMPAIGN, status: "running" }), "u")).rejects.toThrow(/check/);
    // A diagnostic micro-pilot is recorded as such (0056).
    const diagnostic = await call("save_ad_campaign", key, json({ ...CAMPAIGN, purpose: "diagnostic" }), "u");
    expect((await call("ad_campaigns_with_results", key, [diagnostic]))[0].purpose).toBe("diagnostic");
    await expect(call("save_ad_campaign", key, json({ ...CAMPAIGN, purpose: "experiment" }), "u")).rejects.toThrow(/check/);
  });

  it("keeps each shop's campaigns to itself and is function-only", async () => {
    const mine = await boundShop();
    const other = await boundShop();
    const id = await call("save_ad_campaign", mine, json(CAMPAIGN), "u");
    expect(await call("ad_campaigns_with_results", other, null)).toEqual([]);
    await expect(call("save_ad_campaign_results", other, id, json([day("2026-11-01")]), "u")).rejects.toThrow(/not the shop's campaign/);
    await expect(call("save_ad_campaign", other, json({ ...CAMPAIGN, id }), "u")).rejects.toThrow(/not the shop's campaign/);
    await expect(as("service_role", "insert into public.ad_campaigns (shop_key, name, product_ids, status, currency, created_by) values ($1, 'x', '{1}', 'active', 'USD', 'u')", [mine]))
      .rejects.toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.ad_campaigns_with_results($1, null)", [mine])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select public.save_ad_campaign($1, '{}', 'u')", [mine])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select * from public.ad_campaign_results")).rejects.toThrow(/permission denied/);
    }
  });
});
