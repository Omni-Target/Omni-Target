/**
 * Real Postgres tests for the economics policy and the merchant's inputs (Phase 4, task 2; migration 0052):
 * the versioned, immutable policy; the input catalogue's rules; provenance on every saved value; all-or-none
 * saves; and access through the functions only. Synthetic rows only.
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
const save = (key, inputs, by = "user_test") => call("save_economics_inputs", key, JSON.stringify(inputs), by);

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function boundShop(currency = "GBP") {
  const shop = `e-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  if (currency) await q("insert into public.shop_settings (shop_key, currency, timezone) values ($1, $2, 'Europe/London')", [key, currency]);
  return { shop, key };
}

describe("economics policy (0052)", () => {
  it("has one active version: version 2 (0056), still pending approval; version 1 retired, not deleted", async () => {
    const policy = await call("economics_policy", null);
    expect(policy).toMatchObject({ version: 2, status: "active", approval: "pending" });
    expect(policy.settings).toMatchObject({ estimate_downside_factor: 1.5, micro_pilot_min_conversions: 1, refund_maturity_min_days: 30,
      refund_maturity_max_days: 120, refund_lag_min_refunds: 20 });
    expect(policy.rationale.contribution_reserve).toMatch(/fixed operating costs and profit/);
    expect(await call("economics_policy", 1)).toMatchObject({ version: 1, status: "retired", approval: "pending" });
    expect(policy.settings).toMatchObject({ contribution_reserve: 0.3, pilot_conversions: 10, test_conversions: 20, min_test_conversions: 5,
      scale_step: 0.2, return_maturity_days: 60, attribution_lag_days: 7, decision_confidence: 0.9, allow_cost_estimates: false });
    // Every setting has a rationale.
    expect(Object.keys(policy.rationale).sort()).toEqual(Object.keys(policy.settings).sort());
    expect(await call("economics_policy", 999)).toBeNull();
  });

  it("holds version 3 (0057) as a draft: separate scaling and pausing confidence, all limits required; version 2 stays active", async () => {
    const v3 = await call("economics_policy", 3);
    expect(v3).toMatchObject({ version: 3, status: "draft", approval: "pending" });
    expect(v3.settings).toMatchObject({ scale_confidence: 0.975, pause_confidence: 0.95, require_spending_limits: true, refund_maturity_min_days: 60,
      decision_confidence: 0.9, estimate_downside_factor: 1.5 });
    expect(Object.keys(v3.rationale).sort()).toEqual(Object.keys(v3.settings).sort());
    expect((await call("economics_policy", null)).version).toBe(2);
    // Version 3's keys come all together, on top of version 2's, in range.
    const { settings, rationale } = await one("select settings, rationale from public.economics_policies where version = 3");
    const v = 800000 + Math.floor(Math.random() * 99999);
    const insert = (st) => q("insert into public.economics_policies (version, settings, rationale, status) values ($1, $2, $3, 'draft')", [v, st, rationale]);
    const without = (st, k) => { const c = { ...st }; delete c[k]; return c; };
    await expect(insert(without(settings, "pause_confidence"))).rejects.toThrow(/economics_policies_settings_valid/);
    await expect(insert({ ...settings, scale_confidence: 1 })).rejects.toThrow(/economics_policies_settings_valid/);
    await expect(insert({ ...settings, require_spending_limits: "yes" })).rejects.toThrow(/economics_policies_settings_valid/);
    await expect(insert(without(settings, "estimate_downside_factor"))).rejects.toThrow(/economics_policies_settings_valid/);
  });

  it("never changes a written version, refuses invalid settings and allows one active version", async () => {
    await expect(q("update public.economics_policies set settings = settings || '{\"contribution_reserve\": 0.1}' where version = 1"))
      .rejects.toThrow(/economics_policy_immutable/);
    const { settings, rationale } = await one("select settings, rationale from public.economics_policies where version = 1");
    const v = 900000 + Math.floor(Math.random() * 99999);
    const insert = (s, status = "draft") => q("insert into public.economics_policies (version, settings, rationale, status) values ($1, $2, $3, $4)", [v, s, rationale, status]);
    await expect(insert({ ...settings, contribution_reserve: 1 })).rejects.toThrow(/economics_policies_settings_valid/);
    const missing = { ...settings };
    delete missing.scale_step;
    await expect(insert(missing)).rejects.toThrow(/economics_policies_settings_valid/);
    await expect(insert({ ...settings, pilot_conversions: 50 })).rejects.toThrow(/economics_policies_settings_valid/); // pilot > test
    await expect(insert(settings, "active")).rejects.toThrow(/economics_policies_one_active/);
    await insert(settings);
    // Status and approval may move; approval needs its date.
    await expect(q("update public.economics_policies set approval = 'approved' where version = $1", [v])).rejects.toThrow(/check/);
    await q("update public.economics_policies set approval = 'approved', approved_by = 'ceo', approved_at = now(), status = 'retired' where version = $1", [v]);
    await q("delete from public.economics_policies where version = $1", [v]);
  });
});

describe("merchant economics inputs (0052)", () => {
  it("saves shop-wide values and product overrides with their state, currency, author and date", async () => {
    const s = await boundShop("NGN");
    await q("insert into public.products (shop_key, shopify_id, title, status) values ($1, 42, 'Board', 'active')", [s.key]);
    expect(await save(s.key, [
      { key: "payment_rate", value: 0.015, state: "merchant_entered" },
      { key: "payment_fixed_fee", value: 100, state: "merchant_entered" },
      { key: "selling_fee_rate", value: 0, state: "confirmed_none" },
      { key: "shipping_cost_per_order", value: 2500, state: "merchant_entered" },
      { product_id: 42, key: "shipping_cost_per_order", value: 6000, state: "merchant_entered" },
      { product_id: 42, key: "advertising_excluded", value: 1, state: "merchant_entered" },
      { key: "expected_refund_rate", value: 0.04, state: "merchant_estimate" },
      { key: "ad_monthly_limit", value: 500000, state: "merchant_entered" },
    ], "user_owner")).toEqual({ saved: 8, cleared: 0 });

    const read = await call("economics_inputs", s.key, [42]);
    expect(read.currency).toBe("NGN");
    const by = Object.fromEntries(read.inputs.map((i) => [`${i.product_id}:${i.key}`, i]));
    expect(by["0:payment_rate"]).toMatchObject({ value: 0.015, state: "merchant_entered", currency: null, entered_by: "user_owner" });
    expect(by["0:payment_fixed_fee"]).toMatchObject({ value: 100, currency: "NGN" });
    expect(by["0:selling_fee_rate"]).toMatchObject({ value: 0, state: "confirmed_none" });
    expect(by["42:shipping_cost_per_order"]).toMatchObject({ value: 6000, currency: "NGN" });
    expect(by["0:expected_refund_rate"]).toMatchObject({ state: "merchant_estimate" });
    expect(Date.parse(by["0:payment_rate"].entered_at)).toBeGreaterThan(Date.now() - 60_000);
    // Overrides come back only for the products asked about.
    expect((await call("economics_inputs", s.key, [7])).inputs.filter((i) => i.product_id !== 0)).toEqual([]);

    // Saving again replaces the value and its author; clearing makes it unknown again.
    await save(s.key, [{ key: "payment_rate", value: 0.029, state: "merchant_entered" }, { product_id: 42, key: "advertising_excluded", state: "cleared" }], "user_staff");
    const again = Object.fromEntries((await call("economics_inputs", s.key, [42])).inputs.map((i) => [`${i.product_id}:${i.key}`, i]));
    expect(again["0:payment_rate"]).toMatchObject({ value: 0.029, entered_by: "user_staff" });
    expect(again["42:advertising_excluded"]).toBeUndefined();
  });

  it("refuses what the catalogue does not allow, and saves nothing from a batch with one bad value", async () => {
    const s = await boundShop();
    await q("insert into public.products (shop_key, shopify_id, title, status) values ($1, 5, 'Wax', 'active')", [s.key]);
    await expect(save(s.key, [{ product_id: 77, key: "shipping_cost_per_order", value: 5, state: "merchant_entered" }])).rejects.toThrow(/product is not the shop's/);
    const bad = [
      [{ key: "made_up", value: 1, state: "merchant_entered" }, /unknown key/],
      [{ product_id: 5, key: "payment_rate", value: 0.02, state: "merchant_entered" }, /not set at this scope/],
      [{ key: "landed_cost_per_unit", value: 3, state: "merchant_entered" }, /not set at this scope/],
      [{ key: "expected_discount_rate", value: 0.1, state: "merchant_entered" }, /cannot be merchant_entered/],
      [{ key: "ad_test_limit", value: 0, state: "confirmed_none" }, /cannot be confirmed_none/],
      [{ key: "payment_rate", value: 0.5, state: "merchant_entered" }, /out of range/],
      [{ key: "shipping_cost_per_order", value: 5, state: "confirmed_none" }, /out of range/],
      [{ product_id: 5, key: "advertising_excluded", value: 2, state: "merchant_entered" }, /out of range/],
      [{ key: "shipping_cost_per_order", value: -1, state: "merchant_entered" }, /out of range/],
      [{ key: "shipping_cost_per_order", value: "5", state: "merchant_entered" }, /needs a number/],
      [{ key: "shipping_cost_per_order", value: 5 }, /cannot be null/],
    ];
    for (const [input, error] of bad) await expect(save(s.key, [input])).rejects.toThrow(error);
    await expect(save(s.key, [{ key: "payment_rate", value: 0.02, state: "merchant_entered" }, bad[5][0]])).rejects.toThrow(/out of range/);
    expect((await call("economics_inputs", s.key, [])).inputs).toEqual([]);
    await expect(save(s.key, {})).rejects.toThrow(/array/);
    await expect(save(s.key, [], "")).rejects.toThrow(/entered_by/);
  });

  it("needs the shop's currency for money, and a shop bound to an active workspace", async () => {
    const noCurrency = await boundShop(null);
    await expect(save(noCurrency.key, [{ key: "shipping_cost_per_order", value: 5, state: "merchant_entered" }])).rejects.toThrow(/currency is not known/);
    expect(await save(noCurrency.key, [{ key: "payment_rate", value: 0.02, state: "merchant_entered" }])).toMatchObject({ saved: 1 });
    const { shop_key: unbound } = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning shop_key",
      [Math.floor(Math.random() * 9e12) + 1e12, `u-${tag()}.myshopify.com`]);
    await expect(save(unbound, [{ key: "payment_rate", value: 0.02, state: "merchant_entered" }])).rejects.toThrow(/shop_not_ingestible/);
  });

  it("is written through the functions only and read by the service role only", async () => {
    const s = await boundShop();
    await expect(as("service_role", "insert into public.merchant_economics_inputs (shop_key, key, value, state, entered_by) values ($1, 'payment_rate', 0.02, 'merchant_entered', 'x')", [s.key]))
      .rejects.toThrow(/permission denied/);
    await expect(as("service_role", "update public.economics_policies set status = 'retired'")).rejects.toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.economics_policy(null)")).rejects.toThrow(/permission denied/);
      await expect(as(role, "select public.economics_inputs($1, '{}')", [s.key])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select public.save_economics_inputs($1, '[]', 'x')", [s.key])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select * from public.merchant_economics_inputs")).rejects.toThrow(/permission denied/);
    }
  });
});

describe("variant inputs and the purchase-event choice (0056)", () => {
  it("records a confirmed zero cost and a landed cost per variant, only for the product's own variants", async () => {
    const s = await boundShop();
    await q("insert into public.products (shop_key, shopify_id, title, status) values ($1, 42, 'Board', 'active')", [s.key]);
    await q("insert into public.product_variants (shop_key, shopify_id, product_shopify_id, price) values ($1, 421, 42, 10), ($1, 422, 42, 12)", [s.key]);
    expect(await save(s.key, [
      { product_id: 42, variant_id: 421, key: "unit_cost_zero_confirmed", value: 1, state: "merchant_entered" },
      { product_id: 42, variant_id: 422, key: "landed_cost_per_unit", value: 1.5, state: "merchant_entered" },
      { product_id: 42, key: "unit_cost_zero_confirmed", value: 1, state: "merchant_entered" },
      { key: "purchase_event_basis", value: 1, state: "merchant_entered" },
    ], "user_owner")).toMatchObject({ saved: 4 });
    const rows = (await call("economics_inputs", s.key, [42])).inputs;
    expect(rows.find((r) => r.variant_id === 421)).toMatchObject({ key: "unit_cost_zero_confirmed", entered_by: "user_owner" });
    expect(rows.find((r) => r.variant_id === 422)).toMatchObject({ key: "landed_cost_per_unit", value: 1.5, currency: "GBP" });
    await expect(save(s.key, [{ product_id: 42, variant_id: 999, key: "unit_cost_zero_confirmed", value: 1, state: "merchant_entered" }])).rejects.toThrow(/not the product's/);
    await expect(save(s.key, [{ product_id: 42, variant_id: 421, key: "shipping_cost_per_order", value: 5, state: "merchant_entered" }])).rejects.toThrow(/scope/);
    await expect(save(s.key, [{ key: "unit_cost_zero_confirmed", value: 1, state: "merchant_entered" }])).rejects.toThrow(/scope/);
    await expect(save(s.key, [{ key: "purchase_event_basis", value: 0.5, state: "merchant_entered" }])).rejects.toThrow(/out of range/);
    await expect(save(s.key, [{ key: "purchase_event_basis", value: 2, state: "merchant_entered" }])).rejects.toThrow(/out of range/);
    await save(s.key, [{ product_id: 42, variant_id: 421, key: "unit_cost_zero_confirmed", state: "cleared" }]);
    expect((await call("economics_inputs", s.key, [42])).inputs.some((r) => r.variant_id === 421)).toBe(false);
  });
});
