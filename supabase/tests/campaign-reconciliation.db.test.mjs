/**
 * Real Postgres tests for attribution reconciliation and recorded campaign evaluations (Phase 4 closure, migration
 * 0058): what Shopify recorded over a campaign's period, manual reviews, evaluation records, isolation between shops,
 * shop deletion and function-only access. Synthetic rows only; nothing is published or spent.
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
  const domain = `r-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, domain, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [domain]);
  await q("insert into public.shop_settings (shop_key, currency, timezone) values ($1, 'NGN', 'Africa/Lagos')", [key]);
  await q("insert into public.products (shop_key, shopify_id, title, status) values ($1, 1, 'Board', 'active'), ($1, 2, 'Wax', 'active')", [key]);
  return { key, domain };
}
let orderId = 1000;
/** An order of the given products, placed at `at`, with optional journey fields. */
async function order(key, at, products, o = {}) {
  const id = ++orderId;
  await q(`insert into public.orders (shop_key, shopify_id, shopify_created_at, processed_at, currency, financial_status, total_price, is_test, utm_source, referrer_host, visit_source)
    values ($1, $2, $3, $3, 'NGN', $4, 100, $5, $6, $7, $8)`, [key, id, at, o.status ?? "paid", o.test ?? false, o.utm ?? null, o.referrer ?? null, o.visit ?? null]);
  for (const [i, p] of products.entries()) {
    await q("insert into public.order_line_items (shop_key, shopify_id, order_shopify_id, product_shopify_id, quantity, unit_price) values ($1, $2, $3, $4, 1, 100)",
      [key, id * 10 + i, id, p]);
  }
  return id;
}
const CAMPAIGN = { name: "Board test", platform: "meta", product_ids: [1], status: "active", currency: "NGN", daily_budget: 20000,
  authorised_budget: 280000, max_loss: 200000, started_on: "2026-11-10" };
const AS_OF = "2026-11-24T09:00:00Z";

describe("campaign reconciliation evidence (0058)", () => {
  it("counts the campaign's product orders over its period in the shop's time zone, placed and paid, with the events sent and Meta visits", async () => {
    const { key, domain } = await boundShop();
    const id = await call("save_ad_campaign", key, json(CAMPAIGN), "user_owner");
    // Lagos is UTC+1: the window opens at 2026-11-09 00:00 local, 2026-11-08 23:00 UTC.
    await order(key, "2026-11-08T22:59:00Z", [1]);                                   // before the window
    const a = await order(key, "2026-11-08T23:00:00Z", [1], { utm: "facebook" });     // first moment of the window
    const b = await order(key, "2026-11-15T10:00:00Z", [1, 2], { referrer: "l.facebook.com" });
    await order(key, "2026-11-16T10:00:00Z", [1], { status: "pending", visit: "google" }); // placed, not paid (cash on delivery)
    await order(key, "2026-11-17T10:00:00Z", [2]);                                   // another product only
    await order(key, "2026-11-18T10:00:00Z", [1], { test: true });                   // a test order
    await order(key, "2026-11-25T10:00:00Z", [1]);                                   // after the check
    await q("insert into public.capi_events (shopify_order_id, shop_domain, event_type, status, event_sent_at) values ($1, $2, 'Purchase', 'sent', '2026-11-15T10:05:00Z'), ($3, $2, 'Purchase', 'failed', '2026-11-09T00:05:00Z')",
      [String(b), domain, String(a)]);
    await q("insert into public.sync_checkpoints (shop_key, domain, updated_at, watermark) values ($1, 'orders', '2026-11-01T00:00:00Z', '2026-11-24T08:00:00Z')", [key]);
    const e = await call("campaign_reconciliation_evidence", key, id, AS_OF);
    expect(e).toMatchObject({ timezone: "Africa/Lagos", placed: 3, paid: 2, capi_sent: 1, capi_connected: true, meta_visit_orders: 2, journey_known_orders: 3, review: null });
    expect(new Date(e.from).toISOString()).toBe("2026-11-08T23:00:00.000Z");
    expect(new Date(e.orders_fresh_at).toISOString()).toBe("2026-11-24T08:00:00.000Z");
    // Another shop's campaign: nothing.
    const other = await boundShop();
    expect(await call("campaign_reconciliation_evidence", other.key, id, AS_OF)).toBeNull();
  });

  it("reaches as far as the newest order stored when the sync watermark is older (0060): a quiet shop is not out of date", async () => {
    const { key } = await boundShop();
    const id = await call("save_ad_campaign", key, json(CAMPAIGN), "user_owner");
    await q("insert into public.sync_checkpoints (shop_key, domain, updated_at, watermark) values ($1, 'orders', '-infinity', '2026-11-12T03:30:00Z')", [key]);
    await order(key, "2026-11-20T15:00:00Z", [2]);                      // any product counts: the data reaches this far
    await order(key, "2026-11-23T09:00:00Z", [1], { test: true });       // test orders do not
    await order(key, "2026-11-26T09:00:00Z", [1]);                      // nor orders after the check
    const e = await call("campaign_reconciliation_evidence", key, id, AS_OF);
    expect(new Date(e.orders_fresh_at).toISOString()).toBe("2026-11-20T15:00:00.000Z");
  });

  it("records manual reviews for the shop's own campaigns, and returns the latest", async () => {
    const { key } = await boundShop();
    const id = await call("save_ad_campaign", key, json(CAMPAIGN), "user_owner");
    await call("save_ad_campaign_review", key, id, json({ through_day: "2026-11-15", outcome: "confirmed", note: "Checked against Ads Manager." }), "user_owner");
    await call("save_ad_campaign_review", key, id, json({ through_day: "2026-11-17", outcome: "corrected", note: "Pixel duplicate removed; results re-entered." }), "user_owner");
    const e = await call("campaign_reconciliation_evidence", key, id, AS_OF);
    expect(e.review).toMatchObject({ through_day: "2026-11-17", outcome: "corrected", reviewed_by: "user_owner" });
    await expect(call("save_ad_campaign_review", key, id, json({ through_day: "2999-01-01", outcome: "confirmed", note: "Too early" }), "u"))
      .rejects.toThrow(/through_day must be a day that has passed/);
    await expect(call("save_ad_campaign_review", key, id, json({ through_day: "2026-11-17", outcome: "approved", note: "Bad outcome" }), "u"))
      .rejects.toThrow(/ad_campaign_reviews_outcome_check/);
    const other = await boundShop();
    await expect(call("save_ad_campaign_review", other.key, id, json({ through_day: "2026-11-17", outcome: "confirmed", note: "Not mine" }), "u"))
      .rejects.toThrow(/the campaign is not the shop's/);
  });

  it("records campaign evaluations with policy, calc version, inputs and output, all or none, for the shop's own campaigns", async () => {
    const { key } = await boundShop();
    const id = await call("save_ad_campaign", key, json(CAMPAIGN), "user_owner");
    const row = { campaign_id: id, run_id: null, as_of: AS_OF, policy_version: 2, calc_version: "econ-1.1.0", action: "SCALE",
      inputs: { campaign: { id }, policy: { decision_confidence: 0.9 } }, output: { action: "SCALE", next_daily_budget: 24000 } };
    expect(await call("record_ad_campaign_evaluations", key, json([row, { ...row, action: "CONTINUE" }]), "user_owner")).toBe(2);
    const stored = await q("select action, policy_version, calc_version, inputs, output, requested_by from public.ad_campaign_evaluations where campaign_id = $1 order by action", [id]);
    expect(stored).toMatchObject([{ action: "CONTINUE" }, { action: "SCALE", policy_version: 2, calc_version: "econ-1.1.0", output: { next_daily_budget: 24000 }, requested_by: "user_owner" }]);
    const other = await boundShop();
    await expect(call("record_ad_campaign_evaluations", other.key, json([row]), "u")).rejects.toThrow(/a campaign is not the shop's/);
    await expect(call("record_ad_campaign_evaluations", key, json([{ ...row, policy_version: 999 }]), "u")).rejects.toThrow(/policy_version/);
    expect((await q("select count(*)::int as n from public.ad_campaign_evaluations where campaign_id = $1", [id]))[0].n).toBe(2);
  });

  it("is reachable by the service role only, and shop deletion removes reviews and evaluations", async () => {
    await expect(as("anon", "select * from public.ad_campaign_reviews")).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", "select public.campaign_reconciliation_evidence(1, gen_random_uuid(), now())")).rejects.toThrow(/permission denied/);
    await expect(as("service_role", "insert into public.ad_campaign_evaluations (shop_key, campaign_id, as_of, policy_version, calc_version, action, inputs, output) values (1, gen_random_uuid(), now(), 1, 'econ-1.0.0', 'SCALE', '{}', '{}')"))
      .rejects.toThrow(/permission denied/);
    const { key, domain } = await boundShop();
    const id = await call("save_ad_campaign", key, json(CAMPAIGN), "user_owner");
    await call("save_ad_campaign_review", key, id, json({ through_day: "2026-11-17", outcome: "confirmed", note: "Checked counts." }), "user_owner");
    await call("record_ad_campaign_evaluations", key, json([{ campaign_id: id, run_id: null, as_of: AS_OF, policy_version: 2, calc_version: "econ-1.1.0",
      action: "CONTINUE", inputs: {}, output: {} }]), "user_owner");
    const before = await one("select public.shop_synced_row_count($1) as n", [domain]);
    expect(Number(before.n)).toBeGreaterThanOrEqual(5);           // 2 products, settings, campaign, review, evaluation
    await one("select public.delete_shop_synced_data($1)", [domain]);
    expect((await q("select count(*)::int as n from public.ad_campaign_reviews where shop_key = $1", [key]))[0].n).toBe(0);
    expect((await q("select count(*)::int as n from public.ad_campaign_evaluations where shop_key = $1", [key]))[0].n).toBe(0);
    expect(Number((await one("select public.shop_synced_row_count($1) as n", [domain])).n)).toBe(0);
  });
});
