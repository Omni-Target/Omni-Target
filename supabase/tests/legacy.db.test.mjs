/**
 * Real Postgres tests for the legacy account migration (Phase 1, task 6):
 * migrations 0022 (account map, orphans, migration functions) and 0023
 * (workspace columns and their insert triggers). Synthetic rows only.
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

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const domain = () => `l-${tag()}.myshopify.com`;
const gid = () => `gid://shopify/AppPurchaseOneTime/${Math.floor(Math.random() * 9e11) + 1e11}`;

/** A legacy account with history: 1 free + 5 paid - 1 used = 5 credits. */
async function legacyAccount({ shop = domain(), credits = 5, token = true, payments = [{ credits: 5, ref: gid() }] } = {}) {
  const user = `user_legacy_${tag()}`;
  const row = await one(
    `insert into public.user_integrations (clerk_user_id, credits, credits_balance, free_credit_used, shop_domain, shopify_store_url, shopify_access_token, access_token)
     values ($1, $2, $2, true, $3, $3, $4, $4) returning id`, [user, credits, shop, token ? `shpat_${tag()}` : null]);
  for (const p of payments) {
    await q("insert into public.payments (clerk_user_id, provider, pack, currency, credits_granted, status, provider_reference) values ($1, 'shopify', 'starter', 'USD', $2, 'success', $3)", [user, p.credits, p.ref]);
  }
  const campaign = (await one("insert into public.campaigns (clerk_user_id, product_name) values ($1, 'Lamp') returning id", [user])).id;
  await q("insert into public.campaign_brief_versions (campaign_id, clerk_user_id, attempt_number) values ($1, $2, 1)", [campaign, user]);
  await q("insert into public.brief_generation_receipts (clerk_user_id, request_id, request_hash, response) values ($1, $2, 'h', $3)", [user, randomUUID(), { campaignId: campaign }]);
  await q("insert into public.credit_usage (clerk_user_id, credits_used, action) values ($1, 1, 'brief_generated')", [user]);
  await q("insert into public.capi_events (clerk_user_id, shopify_order_id, shop_domain) values ($1, $2, $3)", [user, tag(), shop]);
  return { user, row: row.id, shop, campaign, refs: payments.map((p) => p.ref) };
}
const migrate = async (row) => (await one("select public.migrate_legacy_account($1, 'test') as r", [row])).r;
const balance = async (ws) => (await one("select balance from public.credit_accounts where workspace_id = $1", [ws])).balance;

describe("legacy account migration", () => {
  it("gives each legacy account its own workspace, opening balance, history and purchase records", async () => {
    const a = await legacyAccount();
    const result = await migrate(a.row);
    expect(result).toMatchObject({ outcome: "migrated", claim_status: "provisional", opening_balance: 5, difference: 0, purchases_recorded: 1, credential: "retired_unbound" });
    const ws = result.workspace_id;
    expect(await one("select owner_clerk_user_id, legacy_user_integration_id from public.workspaces where id = $1", [ws])).toEqual({ owner_clerk_user_id: a.user, legacy_user_integration_id: a.row });
    expect(await balance(ws)).toBe(5);
    for (const table of ["campaigns", "campaign_brief_versions", "brief_generation_receipts", "payments", "credit_usage", "capi_events"]) {
      const counts = await one(`select count(*) filter (where workspace_id = $2)::int mine, count(*)::int total from public.${table} where clerk_user_id = $1`, [a.user, ws]);
      expect(counts, table).toEqual({ mine: counts.total, total: counts.total });
    }
    expect(await one("select attribution, review_status, workspace_id, ledger_entry_id from public.provider_purchases where external_id = $1", [a.refs[0]]))
      .toEqual({ attribution: "legacy_record", review_status: "legacy_claimed", workspace_id: ws, ledger_entry_id: null });
    expect((await one("select shopify_access_token is not null as kept from public.user_integrations where id = $1", [a.row])).kept).toBe(true);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const a = await legacyAccount();
    const first = await migrate(a.row);
    const again = await migrate(a.row);
    expect(again).toMatchObject({ outcome: "already_migrated", workspace_id: first.workspace_id });
    expect((await one("select count(*)::int n from public.workspaces where owner_clerk_user_id = $1", [a.user])).n).toBe(1);
    expect(await balance(first.workspace_id)).toBe(5);
  });

  it("never credits a migrated purchase again when reconciliation finds it", async () => {
    const a = await legacyAccount();
    const { workspace_id: ws } = await migrate(a.row);
    const shop = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning id", [String(Math.floor(Math.random() * 9e12) + 1e12), a.shop]);
    const result = (await one(`select public.record_shop_purchase($1, $2, 'one_time', 'starter', 5, 'ACTIVE', false, true, 9, 'USD', now(), '{}'::jsonb) r`, [shop.id, a.refs[0]])).r;
    expect(result.outcome).toBe("legacy_claimed");
    expect(await balance(ws)).toBe(5);
  });

  it("attributes a legacy purchase that reconciliation already recorded without a workspace", async () => {
    const ref = gid();
    const a = await legacyAccount({ payments: [{ credits: 5, ref }] });
    await q("insert into public.processed_payments (payment_id) values ($1)", [`shopify:${ref}`]);
    const shop = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning id", [String(Math.floor(Math.random() * 9e12) + 1e12), a.shop]);
    await q(`select public.record_shop_purchase($1, $2, 'one_time', 'starter', 5, 'ACTIVE', false, true, 9, 'USD', now(), '{}'::jsonb)`, [shop.id, ref]);
    expect((await one("select workspace_id from public.provider_purchases where external_id = $1", [ref])).workspace_id).toBeNull();
    const result = await migrate(a.row);
    expect(result.purchases_recorded).toBe(1);
    expect(await one("select workspace_id, review_status, ledger_entry_id from public.provider_purchases where external_id = $1", [ref]))
      .toEqual({ workspace_id: result.workspace_id, review_status: "legacy_claimed", ledger_entry_id: null });
    expect(await balance(result.workspace_id)).toBe(5);
  });

  it("marks a domain claimed by two legacy accounts as contested, and one already connected as unresolved", async () => {
    const shared = domain();
    const [a, b] = [await legacyAccount({ shop: shared }), await legacyAccount({ shop: shared })];
    await migrate(a.row);
    expect((await migrate(b.row)).claim_status).toBe("contested");
    expect((await q("select status from public.legacy_shop_claims where claimed_domain = $1", [shared])).map((r) => r.status)).toEqual(["contested", "contested"]);

    const connected = domain();
    const owner = `user_new_${tag()}`;
    const ws = (await one("insert into public.workspaces (owner_clerk_user_id) values ($1) returning id", [owner])).id;
    const shop = (await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning id", [String(Math.floor(Math.random() * 9e12) + 1e12), connected])).id;
    await q("insert into public.shop_bindings (shop_id, workspace_id, bound_by_clerk_user_id) values ($1, $2, $3)", [shop, ws, owner]);
    const c = await legacyAccount({ shop: connected });
    const result = await migrate(c.row);
    expect(result.claim_status).toBe("unresolved");
    expect(result.workspace_id).not.toBe(ws);
    expect(await balance(ws)).toBe(0);
  });

  it("records an unexplained balance for review without inventing transactions", async () => {
    const a = await legacyAccount({ credits: 9 });
    const result = await migrate(a.row);
    expect(result).toMatchObject({ opening_balance: 9, difference: 4, opening_needs_review: true });
    expect(await balance(result.workspace_id)).toBe(9);
    expect((await q("select entry_type from public.credit_ledger where workspace_id = $1", [result.workspace_id])).map((r) => r.entry_type)).toEqual(["opening_balance"]);
  });

  it("lists records with no legacy account as orphans and attaches them nowhere", async () => {
    const stranger = `user_gone_${tag()}`;
    const campaign = (await one("insert into public.campaigns (clerk_user_id, product_name) values ($1, 'Mug') returning id", [stranger])).id;
    await q("insert into public.credit_usage (clerk_user_id, credits_used, action) values ($1, 1, 'brief_generated')", [stranger]);
    await q("select public.record_legacy_orphans('test')");
    await q("select public.record_legacy_orphans('test')");
    expect((await q("select source_table from public.legacy_orphans where clerk_user_id = $1 order by 1", [stranger])).map((r) => r.source_table)).toEqual(["campaigns", "credit_usage"]);
    expect((await one("select workspace_id from public.campaigns where id = $1", [campaign])).workspace_id).toBeNull();
  });

  it("leaves no trace when run as a dry run and rolled back", async () => {
    const a = await legacyAccount();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const r = (await client.query("select public.migrate_legacy_account($1, 'dry') as r", [a.row])).rows[0].r;
      expect(r.outcome).toBe("migrated");
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect((await one("select count(*)::int n from public.workspaces where owner_clerk_user_id = $1", [a.user])).n).toBe(0);
    expect((await one("select count(*)::int n from public.legacy_account_map where legacy_row_id = $1", [a.row])).n).toBe(0);
    expect((await one("select count(*)::int n from public.campaigns where clerk_user_id = $1 and workspace_id is not null", [a.user])).n).toBe(0);
  });

  it("clears plaintext credentials only for a migrated account, once", async () => {
    const a = await legacyAccount();
    await expect(q("select public.clear_legacy_plaintext_credentials($1)", [a.row])).rejects.toThrow(/legacy_row_not_migrated/);
    await migrate(a.row);
    expect((await one("select public.clear_legacy_plaintext_credentials($1) as r", [a.row])).r).toBe("cleared");
    expect((await one("select public.clear_legacy_plaintext_credentials($1) as r", [a.row])).r).toBe("cleared");
    expect(await one("select shopify_access_token, access_token, credits, shop_domain from public.user_integrations where id = $1", [a.row]))
      .toEqual({ shopify_access_token: null, access_token: null, credits: 5, shop_domain: a.shop });
    expect((await one("select credential_outcome from public.legacy_account_map where legacy_row_id = $1", [a.row])).credential_outcome).toBe("cleared");
  });

  it("is not callable by the application role", async () => {
    for (const fn of ["migrate_legacy_account(uuid,text)", "record_legacy_orphans(text)", "clear_legacy_plaintext_credentials(uuid)"]) {
      expect((await one(`select has_function_privilege('service_role', 'public.${fn}', 'execute') as x`)).x, fn).toBe(false);
    }
  });
});

describe("a migrated legacy owner reconnecting their shop (acceptance)", () => {
  it("binds the shop into the legacy workspace, with its credits and history, and refuses anyone else first", async () => {
    const a = await legacyAccount();
    const { workspace_id: legacyWs } = await migrate(a.row);
    const shopifyId = String(Math.floor(Math.random() * 9e12) + 1e12);

    // Another account cannot take the claimed shop before its legacy owner reconnects.
    const intruder = (await one("select public.bind_shop_for_install($1, $2, $3, null, 'Shop') as r", [shopifyId, a.shop, `user_other_${tag()}`])).r;
    expect(intruder.outcome).toBe("rejected_legacy_claim");

    // The legacy owner's first connection lands in the legacy workspace, not a new one.
    const bound = (await one("select public.bind_shop_for_install($1, $2, $3, null, 'Shop') as r", [shopifyId, a.shop, a.user])).r;
    expect(bound).toMatchObject({ outcome: "bound_existing_workspace", workspace_id: legacyWs });
    expect((await one("select count(*)::int n from public.workspaces where owner_clerk_user_id = $1", [a.user])).n).toBe(1);
    expect(await one("select status, shop_id is not null as has_shop from public.legacy_shop_claims where legacy_row_id = $1", [a.row]))
      .toEqual({ status: "confirmed", has_shop: true });

    // Credits and history are there; the legacy free credit is not granted twice.
    expect((await one("select public.workspace_credit_status($1, $2) as r", [legacyWs, a.user])).r).toMatchObject({ balance: 5 });
    expect((await one("select count(*)::int n from public.campaigns where workspace_id = $1 and id = $2", [legacyWs, a.campaign])).n).toBe(1);
    expect((await one("select public.grant_workspace_free_credit($1, $2) as r", [legacyWs, a.user])).r.outcome).toBe("legacy_free_credit_used");

    // The migrated balance pays for a new brief through the ledger.
    const brief = (await one(
      `select public.commit_brief_generation($1, $2, $3, 'h', null, '{"product_name":"Lamp"}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) as r`,
      [legacyWs, a.user, randomUUID()])).r;
    expect(brief.credits_balance).toBe(4);
    expect((await q("select entry_type from public.credit_ledger where workspace_id = $1 order by id", [legacyWs])).map((r) => r.entry_type))
      .toEqual(["opening_balance", "consumption"]);
  });
});

describe("workspace columns for rows written by the current code (0023)", () => {
  it("fills the workspace of versions, receipts, intent payments and CAPI events from what they belong to", async () => {
    const owner = `user_cur_${tag()}`;
    const ws = (await one("insert into public.workspaces (owner_clerk_user_id) values ($1) returning id", [owner])).id;
    const shopDomain = domain();
    const shop = (await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning id", [String(Math.floor(Math.random() * 9e12) + 1e12), shopDomain])).id;
    await q("insert into public.shop_bindings (shop_id, workspace_id, bound_by_clerk_user_id) values ($1, $2, $3)", [shop, ws, owner]);
    const campaign = (await one("insert into public.campaigns (clerk_user_id, product_name, workspace_id) values ($1, 'Lamp', $2) returning id", [owner, ws])).id;
    const version = await one("insert into public.campaign_brief_versions (campaign_id, clerk_user_id, attempt_number) values ($1, $2, 1) returning workspace_id", [campaign, owner]);
    const receipt = await one("insert into public.brief_generation_receipts (clerk_user_id, request_id, request_hash, response) values ($1, $2, 'h', $3) returning workspace_id", [owner, randomUUID(), { campaignId: campaign }]);
    const paymentId = randomUUID();
    await q("insert into public.purchase_intents (workspace_id, purchaser_clerk_user_id, provider, plan_key, kind, credits, external_charge_id, status) values ($1, $2, 'stripe', 'starter', 'one_time', 3, $3, 'pending')", [ws, owner, paymentId]);
    const payment = await one("insert into public.payments (id, clerk_user_id, provider, pack, currency, credits_granted, status) values ($1, $2, 'stripe', 'starter', 'USD', 3, 'pending') returning workspace_id", [paymentId, owner]);
    const capi = await one("insert into public.capi_events (clerk_user_id, shopify_order_id, shop_domain) values ($1, $2, $3) returning workspace_id", [owner, tag(), shopDomain]);
    expect([version.workspace_id, receipt.workspace_id, payment.workspace_id, capi.workspace_id]).toEqual([ws, ws, ws, ws]);
  });
});
