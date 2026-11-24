/**
 * Real Postgres tests for recorded economics runs (Phase 4, task 6; migration 0054): all-or-none recording,
 * the zero and no-amount rules held by the table itself, reading back for recomputation, the latest
 * recommendation per product, isolation between shops and function-only access. Synthetic rows only.
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
  const shop = `r-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return key;
}
const RUN = { as_of: "2026-11-24T00:00:00Z", calc_version: "econ-1.0.0", policy_version: 1, trigger: "portfolio", requested_by: "user_test",
  portfolio: { monthly_limit: 1000, allocated: 420 }, summary: { GO: 1, INSUFFICIENT_DATA: 1 } };
const rec = (productId, patch = {}) => ({ product_id: productId, verdict: "GO", reasons: [], currency: "USD", budget_status: "recommended",
  test_budget: 420, daily_budget: 30, test_days: 14, break_even_cpa: 30, target_cpa: 21,
  inputs: { product: { product_id: productId }, policy: { contribution_reserve: 0.3 } }, outputs: { verdict: patch.verdict ?? "GO", product_id: productId }, ...patch });
const runsFor = async (key) => (await one("select count(*)::int as n from public.economics_runs where shop_key = $1", [key])).n;

describe("recorded economics runs (0054)", () => {
  it("records a run and its recommendations, and reads them back for recomputation", async () => {
    const key = await boundShop();
    const insufficient = rec(2, { verdict: "INSUFFICIENT_DATA", reasons: ["UNIT_COST_MISSING"], budget_status: "withheld", test_budget: null,
      daily_budget: null, test_days: null, break_even_cpa: null, target_cpa: null });
    const id = await call("record_economics_run", key, json(RUN), json([rec(1), insufficient]));
    const read = await call("economics_run", key, id);
    expect(read.run).toMatchObject({ id, calc_version: "econ-1.0.0", policy_version: 1, trigger: "portfolio", products: 2,
      portfolio: { monthly_limit: 1000 }, summary: { GO: 1 } });
    expect(read.recommendations.map((r) => [r.product_id, r.outputs.verdict])).toEqual([[1, "GO"], [2, "INSUFFICIENT_DATA"]]);
    expect(read.recommendations[0].inputs).toEqual({ product: { product_id: 1 }, policy: { contribution_reserve: 0.3 } });
    expect(await one("select verdict, reasons, budget_status, test_budget, test_days from public.product_recommendations where run_id = $1 and product_shopify_id = 2", [id]))
      .toEqual({ verdict: "INSUFFICIENT_DATA", reasons: ["UNIT_COST_MISSING"], budget_status: "withheld", test_budget: null, test_days: null });
  });

  it("returns each product's latest recommendation", async () => {
    const key = await boundShop();
    await call("record_economics_run", key, json(RUN), json([rec(1), rec(2)]));
    const later = await call("record_economics_run", key, json({ ...RUN, trigger: "brief" }), json([rec(1, { verdict: "PILOT", outputs: { verdict: "PILOT" } })]));
    const latest = await call("latest_product_recommendations", key, [1, 2, 3]);
    expect(latest.map((l) => [l.product_id, l.verdict])).toEqual([[1, "PILOT"], [2, "GO"]]);
    expect(latest[0].run_id).toBe(later);
  });

  it("holds the zero and no-amount rules itself, and records all or none", async () => {
    const key = await boundShop();
    const fails = async (recs, pattern, run = RUN) => {
      const before = await runsFor(key);
      await expect(call("record_economics_run", key, json(run), json(recs))).rejects.toThrow(pattern);
      expect(await runsFor(key)).toBe(before);
    };
    await fails([rec(1, { verdict: "BLOCKED", budget_status: "zero", test_budget: 50 })], /check/);
    await fails([rec(1, { verdict: "DO_NOT_LAUNCH", budget_status: "zero", test_budget: 0, daily_budget: 3 })], /check/);
    await fails([rec(1, { verdict: "INSUFFICIENT_DATA", budget_status: "withheld", test_budget: 0, daily_budget: null })], /check/);
    await fails([rec(1), rec(2, { verdict: "MAYBE" })], /check/);
    await fails([], /1 to 200/);
    await fails([rec(1)], /check/, { ...RUN, calc_version: "v1" });
    await fails([rec(1)], /foreign key/, { ...RUN, policy_version: 999 });
    const { shop_key: unbound } = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning shop_key",
      [Math.floor(Math.random() * 9e12) + 1e12, `u-${tag()}.myshopify.com`]);
    await expect(call("record_economics_run", unbound, json(RUN), json([rec(1)]))).rejects.toThrow(/shop_not_ingestible/);
  });

  it("keeps each shop's runs to itself, removes recommendations with their run, and is function-only", async () => {
    const mine = await boundShop();
    const other = await boundShop();
    const id = await call("record_economics_run", mine, json(RUN), json([rec(1)]));
    expect(await call("economics_run", other, id)).toBeNull();
    expect(await call("latest_product_recommendations", other, [1])).toEqual([]);
    // The table owner stands in for the shop-data removal, which cascades to the recommendations.
    await q("delete from public.economics_runs where id = $1", [id]);
    expect((await one("select count(*)::int as n from public.product_recommendations where run_id = $1", [id])).n).toBe(0);
    await expect(as("service_role", "insert into public.economics_runs (shop_key, as_of, calc_version, policy_version, trigger, products) values ($1, now(), 'econ-1.0.0', 1, 'check', 1)", [mine]))
      .rejects.toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.record_economics_run($1, '{}', '[]')", [mine])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select public.latest_product_recommendations($1, '{1}')", [mine])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select * from public.product_recommendations")).rejects.toThrow(/permission denied/);
    }
  });
});
