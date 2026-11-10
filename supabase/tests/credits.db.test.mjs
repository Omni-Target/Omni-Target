/**
 * Real Postgres tests for the workspace credit ledger (Phase 1, task 5).
 * Functions run as service_role, the role the application uses, against a
 * throwaway database with synthetic workspaces, shops and users only.
 * Fixtures that the application never writes directly (shops, bindings with
 * chosen dates, legacy rows) are inserted as the database owner.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 25 });

const q = async (sql, params) => (await pool.query(sql, params)).rows;

async function asService(sql, params) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
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
const invocation = (fn, args) => `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`;
const call = async (fn, ...args) => (await asService(invocation(fn, args), args))[0].result;
const settled = (promises) => Promise.allSettled(promises);

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const user = () => `user_test_${tag()}`;
const domain = () => `c-${tag()}.myshopify.com`;
const shopifyId = () => String(Math.floor(Math.random() * 9e12) + 1e12);
const chargeId = () => `gid://shopify/AppPurchaseOneTime/${Math.floor(Math.random() * 9e11) + 1e11}`;

async function newShop() {
  return (await q("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning id", [shopifyId(), domain()]))[0].id;
}
const created = [];
async function newWorkspace(owner = user()) {
  const id = (await q("insert into public.workspaces (owner_clerk_user_id) values ($1) returning id", [owner]))[0].id;
  created.push(id);
  return { owner, id };
}
async function bindAt(shop, ws, { boundAt = "now() - interval '1 day'", releasedAt = null } = {}) {
  await q(`insert into public.shop_bindings (shop_id, workspace_id, bound_by_clerk_user_id, bound_at, released_at, release_reason)
           values ($1, $2, $3, ${boundAt}, ${releasedAt ?? "null"}, ${releasedAt ? "'ownership_transferred'" : "null"})`, [shop, ws.id, ws.owner]);
}
/** An active workspace with its own connected shop. */
async function connected(owner = user()) {
  const ws = await newWorkspace(owner);
  const shop = await newShop();
  await bindAt(shop, ws);
  return { ...ws, shop };
}
const balance = async (ws) => (await q("select balance from public.credit_accounts where workspace_id = $1", [ws.id ?? ws]))[0].balance;
const entries = async (ws) => q("select entry_type, quantity, balance_after, idempotency_key from public.credit_ledger where workspace_id = $1 order by id", [ws.id ?? ws]);
const purchase = async (externalId) => (await q("select * from public.provider_purchases where external_id = $1", [externalId]))[0];
const adjust = (ws, delta, key = tag()) => call("adjust_workspace_credits", ws.id, delta, key, "support_test", "test adjustment", {});

async function shopifyIntent(ws, { plan = "starter", credits = 3, unlimited = 0, charge = chargeId() } = {}) {
  const intent = await call("create_purchase_intent", ws.id, ws.owner, "shopify", plan, "one_time", credits, unlimited, 9, "USD", null);
  await call("attach_intent_charge", intent.intent_id, charge);
  return { ...intent, charge };
}
const grantIntent = (charge, { plan = "starter", creditable = true, status = "ACTIVE" } = {}) =>
  call("grant_intent_purchase", "shopify", charge, plan, status, false, creditable, 9, "USD", new Date().toISOString(), {});
const recordShopPurchase = (shop, charge, { at, creditable = true, credits = 3, kind = "one_time", plan = "starter" } = {}) =>
  call("record_shop_purchase", shop, charge, kind, plan, credits, "ACTIVE", false, creditable, 9, "USD", at ?? new Date().toISOString(), {});
const commit = (ws, actor, { requestId = randomUUID(), hash = "h", campaignId = null, product = "Lamp" } = {}) =>
  call("commit_brief_generation", ws.id, actor, requestId, hash, campaignId,
    { product_name: product, product_description: "d", campaign_goal: "sales", product_price: "10" },
    { headline: "H", primary_text: "P", description: "D", cta: "Buy", copywriter_note: "n" }, {}, { ok: true });

afterAll(async () => {
  // Invariant over every workspace these tests created: its balance equals its ledger total.
  const drift = await q(`select a.workspace_id from public.credit_accounts a
    left join (select workspace_id, sum(quantity) total from public.credit_ledger group by workspace_id) l using (workspace_id)
    where a.workspace_id = any($1::uuid[]) and a.balance <> coalesce(l.total, 0)`, [created]);
  await pool.end();
  expect(created.length).toBeGreaterThan(30);
  expect(drift).toEqual([]);
});

describe("access", () => {
  it("lets service_role only read the ledger tables and call the typed operations", async () => {
    const ws = await connected();
    for (const sql of [
      ["update public.credit_accounts set balance = 5 where workspace_id = $1", [ws.id]],
      ["insert into public.credit_ledger (workspace_id, entry_type, quantity, balance_after, idempotency_key) values ($1, 'adjustment', 5, 5, 'x')", [ws.id]],
      ["select public.apply_credit_mutation($1, 'purchase', 5, 'k', 'u', null, 'shopify', 'x', 'r', '{}'::jsonb)", [ws.id]],
      ["select public.open_legacy_credit_balance($1)", [ws.id]],
    ]) {
      await expect(asService(...sql)).rejects.toThrow(/permission denied/);
    }
    expect(await balance(ws)).toBe(0);
  });

  it("refuses any balance change outside the ledger, even by the owner", async () => {
    const ws = await connected();
    await expect(q("update public.credit_accounts set balance = 9 where workspace_id = $1", [ws.id])).rejects.toThrow(/only_through_ledger/);
    await expect(q("insert into public.credit_accounts (workspace_id, balance) values (gen_random_uuid(), 3)")).rejects.toThrow();
  });

  it("keeps the ledger append-only", async () => {
    const ws = await connected();
    await adjust(ws, 2);
    await expect(q("update public.credit_ledger set quantity = 50 where workspace_id = $1", [ws.id])).rejects.toThrow(/append_only/);
    await expect(q("delete from public.credit_ledger where workspace_id = $1", [ws.id])).rejects.toThrow(/append_only/);
    await expect(q("truncate public.credit_ledger cascade")).rejects.toThrow(/append_only/);
  });

  it("retires every legacy user-keyed balance writer", async () => {
    for (const sql of [
      "select public.add_user_credits('u', 1, 1)", "select public.increment_credits('u', 1, 1)",
      "select public.grant_free_credit('u')", "select public.apply_credit_adjustment('k', 'u', 1, 'r', '{}'::jsonb)",
    ]) {
      await expect(q(sql)).rejects.toThrow(/credit_function_retired/);
      await expect(asService(sql)).rejects.toThrow(/permission denied/);
    }
  });

  it("shows a workspace's credits only to its owner", async () => {
    const ws = await connected();
    await adjust(ws, 4);
    expect(await call("workspace_credit_status", ws.id, ws.owner)).toMatchObject({ balance: 4, is_unlimited: false });
    await expect(call("workspace_credit_status", ws.id, user())).rejects.toThrow(/workspace_access_denied/);
  });
});

describe("free credit", () => {
  it("grants one free credit per workspace, however many requests arrive", async () => {
    const ws = await connected();
    const results = await Promise.all(Array.from({ length: 10 }, () => call("grant_workspace_free_credit", ws.id, ws.owner)));
    expect(results.filter((r) => r.outcome === "granted")).toHaveLength(1);
    expect(await balance(ws)).toBe(1);
  });

  it("never grants a second free credit for the same shop to a new workspace", async () => {
    const first = await connected();
    await call("grant_workspace_free_credit", first.id, first.owner);
    await q("update public.shop_bindings set released_at = now(), release_reason = 'ownership_transferred' where workspace_id = $1", [first.id]);
    const second = await newWorkspace();
    await bindAt(first.shop, second, { boundAt: "now()" });
    expect((await call("grant_workspace_free_credit", second.id, second.owner)).outcome).toBe("shop_already_granted");
    expect(await balance(second)).toBe(0);
  });

  it("gives nothing to a workspace without a connected shop", async () => {
    const ws = await newWorkspace();
    expect((await call("grant_workspace_free_credit", ws.id, ws.owner)).outcome).toBe("workspace_inactive");
  });
});

describe("consumption through brief generation", () => {
  it("refuses a brief without credits and charges nothing", async () => {
    const ws = await connected();
    await expect(commit(ws, ws.owner)).rejects.toThrow(/no_credits/);
    expect(await entries(ws)).toEqual([]);
    expect((await q("select count(*)::int n from public.campaigns where workspace_id = $1", [ws.id]))[0].n).toBe(0);
  });

  it("spends the last credit exactly once under concurrent generations", async () => {
    const ws = await connected();
    await adjust(ws, 1);
    const results = await settled(Array.from({ length: 8 }, () => commit(ws, ws.owner)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => /no_credits/.test(r.reason.message))).toBe(true);
    expect(await balance(ws)).toBe(0);
    expect((await entries(ws)).map((e) => e.entry_type)).toEqual(["adjustment", "consumption"]);
  });

  it("returns the same receipt for a retried request and debits once", async () => {
    const ws = await connected();
    await adjust(ws, 3);
    const requestId = randomUUID();
    const [a, b] = await Promise.all([commit(ws, ws.owner, { requestId }), commit(ws, ws.owner, { requestId })]);
    expect(a.campaignId).toBe(b.campaignId);
    expect(await balance(ws)).toBe(2);
    await expect(commit(ws, ws.owner, { requestId, hash: "different" })).rejects.toThrow(/idempotency_conflict/);
  });

  it("debits the workspace that generated, never another workspace of the same user", async () => {
    const owner = user();
    const [one, two] = [await connected(owner), await connected(owner)];
    await adjust(one, 2);
    await adjust(two, 5);
    const result = await commit(one, owner);
    expect(result.credits_balance).toBe(1);
    expect([await balance(one), await balance(two)]).toEqual([1, 5]);
    expect((await q("select workspace_id, clerk_user_id from public.campaigns where id = $1", [result.campaignId]))[0])
      .toEqual({ workspace_id: one.id, clerk_user_id: owner });
  });

  it("refuses another user's workspace and keeps regenerations creator-only and free", async () => {
    const ws = await connected();
    await adjust(ws, 1);
    await expect(commit(ws, user())).rejects.toThrow(/workspace_access_denied/);
    const first = await commit(ws, ws.owner);
    const again = await commit(ws, ws.owner, { campaignId: first.campaignId });
    expect(again.attemptNumber).toBe(2);
    expect(await balance(ws)).toBe(0);
    const other = await connected();
    await expect(commit(other, other.owner, { campaignId: first.campaignId })).rejects.toThrow(/invalid_regeneration/);
  });

  it("does not debit during an unlimited entitlement", async () => {
    const ws = await connected();
    const intent = await shopifyIntent(ws, { credits: 0, unlimited: 30 });
    expect((await grantIntent(intent.charge)).outcome).toBe("granted");
    const status = await call("workspace_credit_status", ws.id, ws.owner);
    expect(status.is_unlimited).toBe(true);
    const result = await commit(ws, ws.owner);
    expect(result.is_unlimited).toBe(true);
    expect(await balance(ws)).toBe(0);
    expect(await entries(ws)).toEqual([]);
  });
});

describe("purchases with an intent", () => {
  it("credits the intent's workspace and purchaser once, however often the charge is reported", async () => {
    const ws = await connected();
    const intent = await shopifyIntent(ws);
    const results = await Promise.all(Array.from({ length: 10 }, () => grantIntent(intent.charge)));
    expect(results.filter((r) => r.outcome === "granted")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(9);
    expect(await balance(ws)).toBe(3);
    const row = await purchase(intent.charge);
    expect(row).toMatchObject({ workspace_id: ws.id, purchaser_clerk_user_id: ws.owner, attribution: "intent", review_status: "granted" });
    expect((await q("select status from public.purchase_intents where id = $1", [intent.intent_id]))[0].status).toBe("granted");
  });

  it("records an uncreditable charge without credits and credits it once it becomes creditable", async () => {
    const ws = await connected();
    const intent = await shopifyIntent(ws);
    expect((await grantIntent(intent.charge, { creditable: false, status: "PENDING" })).outcome).toBe("not_creditable");
    expect(await balance(ws)).toBe(0);
    expect((await grantIntent(intent.charge)).outcome).toBe("granted");
    expect((await grantIntent(intent.charge)).outcome).toBe("duplicate");
    expect(await balance(ws)).toBe(3);
  });

  it("refuses a charge whose plan differs from the intent", async () => {
    const ws = await connected();
    const intent = await shopifyIntent(ws);
    await expect(grantIntent(intent.charge, { plan: "scale" })).rejects.toThrow(/intent_plan_mismatch/);
    expect(await purchase(intent.charge)).toBeUndefined();
  });

  it("writes nothing when the payment record is missing, and grants on the retry once it exists", async () => {
    const ws = await connected();
    const payment = randomUUID();
    const intent = await call("create_purchase_intent", ws.id, ws.owner, "stripe", "starter", "one_time", 3, 0, 9, "USD", payment);
    await expect(call("grant_intent_purchase", "stripe", payment, null, "paid", false, true, 9, "USD", null, {}))
      .rejects.toThrow(/payment_record_missing/);
    expect(await purchase(payment)).toBeUndefined();
    expect(await entries(ws)).toEqual([]);
    expect((await q("select status from public.purchase_intents where id = $1", [intent.intent_id]))[0].status).toBe("pending");

    await q("insert into public.payments (id, clerk_user_id, provider, pack, currency, credits_granted, status) values ($1, $2, 'stripe', 'starter', 'USD', 3, 'pending')", [payment, ws.owner]);
    const result = await call("grant_intent_purchase", "stripe", payment, null, "paid", false, true, 9, "USD", null, { provider_reference: "pi_123" });
    expect(result.outcome).toBe("granted");
    expect((await q("select status, provider_reference from public.payments where id = $1", [payment]))[0]).toEqual({ status: "success", provider_reference: "pi_123" });
    expect(await balance(ws)).toBe(3);
  });

  it("refuses intents for another user's workspace or a workspace without a shop", async () => {
    const ws = await connected();
    await expect(call("create_purchase_intent", ws.id, user(), "shopify", "starter", "one_time", 3, 0, 9, "USD", null)).rejects.toThrow(/workspace_access_denied/);
    const bare = await newWorkspace();
    await expect(call("create_purchase_intent", bare.id, bare.owner, "shopify", "starter", "one_time", 3, 0, 9, "USD", null)).rejects.toThrow(/shop_not_connected/);
  });

  it("attaches a charge to one intent only", async () => {
    const ws = await connected();
    const first = await shopifyIntent(ws);
    const second = await call("create_purchase_intent", ws.id, ws.owner, "shopify", "starter", "one_time", 3, 0, 9, "USD", null);
    await expect(call("attach_intent_charge", second.intent_id, first.charge)).rejects.toThrow(/charge_already_attached/);
  });
});

describe("purchases without an intent", () => {
  it("leaves a purchase from before any binding unattributed and uncredited", async () => {
    const ws = await connected();
    const charge = chargeId();
    const result = await recordShopPurchase(ws.shop, charge, { at: new Date(Date.now() - 10 * 86400e3).toISOString() });
    expect(result.outcome).toBe("needs_review");
    expect(await purchase(charge)).toMatchObject({ attribution: "unattributed", workspace_id: null, ledger_entry_id: null });
    expect(await balance(ws)).toBe(0);
  });

  it("credits the workspace whose binding covered the purchase, never the shop's new workspace", async () => {
    const shop = await newShop();
    const old = await newWorkspace();
    const current = await newWorkspace();
    await bindAt(shop, old, { boundAt: "now() - interval '3 days'", releasedAt: "now() - interval '1 day'" });
    await bindAt(shop, current, { boundAt: "now() - interval '1 day'" });
    const day = 86400e3;

    const during = chargeId();
    expect((await recordShopPurchase(shop, during, { at: new Date(Date.now() - 2 * day).toISOString() })).outcome).toBe("granted");
    const atHandover = chargeId();
    expect((await recordShopPurchase(shop, atHandover, { at: new Date(Date.now() - day + 60e3).toISOString() })).outcome).toBe("needs_review");
    const recent = chargeId();
    expect((await recordShopPurchase(shop, recent, { at: new Date(Date.now() - day / 2).toISOString() })).outcome).toBe("granted");

    expect([await balance(old), await balance(current)]).toEqual([3, 3]);
    expect((await purchase(during)).workspace_id).toBe(old.id);
    expect((await purchase(atHandover)).workspace_id).toBeNull();
    expect((await purchase(recent)).workspace_id).toBe(current.id);
  });

  it("never re-credits a charge the legacy code already claimed", async () => {
    const ws = await connected();
    const charge = chargeId();
    await q("insert into public.processed_payments (payment_id) values ($1)", [`shopify:${charge}`]);
    expect((await recordShopPurchase(ws.shop, charge)).outcome).toBe("legacy_claimed");
    expect(await purchase(charge)).toMatchObject({ attribution: "legacy_record", workspace_id: null, ledger_entry_id: null });
    expect(await balance(ws)).toBe(0);
  });

  it("treats the subscription period the legacy code credited as claimed, but grants later renewals", async () => {
    const ws = await connected();
    const sub = `gid://shopify/AppSubscription/${tag()}`;
    await q("insert into public.processed_payments (payment_id, processed_at) values ($1, now() - interval '5 days')", [`shopify:${sub}`]);
    const covered = await recordShopPurchase(ws.shop, `${sub}@a`, { kind: "subscription_period", credits: 10, plan: "growth", at: new Date(Date.now() - 20 * 86400e3).toISOString() });
    expect(covered.outcome).toBe("legacy_claimed");
    const renewal = await recordShopPurchase(ws.shop, `${sub}@b`, { kind: "subscription_period", credits: 10, plan: "growth", at: new Date(Date.now() - 2 * 3600e3).toISOString() });
    expect(renewal.outcome).toBe("granted");
    expect(await balance(ws)).toBe(10);
  });

  it("grants each subscription period once", async () => {
    const ws = await connected();
    const sub = `gid://shopify/AppSubscription/${tag()}`;
    const period = (end) => recordShopPurchase(ws.shop, `${sub}@${end}`, { kind: "subscription_period", credits: 10, plan: "growth" });
    expect((await period("2026-12-01")).outcome).toBe("granted");
    expect((await period("2026-12-01")).outcome).toBe("duplicate");
    expect((await period("2027-01-01")).outcome).toBe("granted");
    expect(await balance(ws)).toBe(20);
    expect((await entries(ws)).map((e) => e.entry_type)).toEqual(["subscription_grant", "subscription_grant"]);
  });
});

describe("reversals, refunds and adjustments", () => {
  it("reverses a purchase exactly once and marks the payment record", async () => {
    const ws = await connected();
    const intent = await shopifyIntent(ws);
    const { ledger_entry_id: entry } = await grantIntent(intent.charge);
    const key = tag();
    const [a, b] = await Promise.all([
      call("reverse_credit_entry", entry, key, "support_test", "chargeback"),
      call("reverse_credit_entry", entry, key, "support_test", "chargeback"),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["applied", "duplicate"]);
    await expect(call("reverse_credit_entry", entry, tag(), "support_test", "again")).rejects.toThrow(/already_reversed/);
    expect(await balance(ws)).toBe(0);
    expect((await purchase(intent.charge)).review_status).toBe("reversed");
  });

  it("refuses a reversal or refund the balance cannot cover, changing nothing", async () => {
    const ws = await connected();
    const intent = await shopifyIntent(ws);
    const { ledger_entry_id: entry } = await grantIntent(intent.charge);
    await adjust(ws, -2);
    await expect(call("reverse_credit_entry", entry, tag(), "support_test", "chargeback")).rejects.toThrow(/insufficient_credits/);
    await expect(call("refund_purchase", "shopify", intent.charge, tag(), 3, "support_test", "refund")).rejects.toThrow(/insufficient_credits/);
    expect(await balance(ws)).toBe(1);
    expect((await purchase(intent.charge)).review_status).toBe("granted");
  });

  it("refunds at most what a purchase granted, idempotently", async () => {
    const ws = await connected();
    const intent = await shopifyIntent(ws);
    await grantIntent(intent.charge);
    const refund = tag();
    expect((await call("refund_purchase", "shopify", intent.charge, refund, 1, "support_test", "partial")).outcome).toBe("applied");
    expect((await call("refund_purchase", "shopify", intent.charge, refund, 1, "support_test", "partial")).outcome).toBe("duplicate");
    await expect(call("refund_purchase", "shopify", intent.charge, tag(), 3, "support_test", "too much")).rejects.toThrow(/refund_exceeds_purchase/);
    expect((await call("refund_purchase", "shopify", intent.charge, tag(), 2, "support_test", "rest")).outcome).toBe("applied");
    expect(await balance(ws)).toBe(0);
    expect((await purchase(intent.charge)).review_status).toBe("refunded");
  });

  it("returns a consumed credit by reversing the consumption", async () => {
    const ws = await connected();
    await adjust(ws, 1);
    await commit(ws, ws.owner);
    const [consumption] = await q("select id from public.credit_ledger where workspace_id = $1 and entry_type = 'consumption'", [ws.id]);
    await call("reverse_credit_entry", consumption.id, tag(), "support_test", "failed brief");
    expect(await balance(ws)).toBe(1);
  });

  it("applies adjustments idempotently and never below zero", async () => {
    const ws = await connected();
    const key = tag();
    expect((await adjust(ws, 5, key)).outcome).toBe("applied");
    expect((await adjust(ws, 5, key)).outcome).toBe("duplicate");
    await expect(adjust(ws, 7, key)).rejects.toThrow(/idempotency_conflict/);
    await expect(adjust(ws, -6)).rejects.toThrow(/insufficient_credits/);
    await expect(call("adjust_workspace_credits", ws.id, 1, tag(), "support_test", " ", {})).rejects.toThrow(/reason_required/);
    expect(await balance(ws)).toBe(5);
  });

  it("keeps the balance equal to the ledger under mixed concurrent activity", async () => {
    const ws = await connected();
    await adjust(ws, 5);
    await settled([
      ...Array.from({ length: 10 }, () => adjust(ws, 1)),
      ...Array.from({ length: 12 }, () => commit(ws, ws.owner)),
      ...Array.from({ length: 4 }, () => adjust(ws, -2)),
    ]);
    const rows = await entries(ws);
    const total = rows.reduce((sum, e) => sum + e.quantity, 0);
    expect(await balance(ws)).toBe(total);
    expect(rows.every((e) => e.balance_after >= 0)).toBe(true);
    expect(rows.at(-1).balance_after).toBe(total);
  });
});

describe("entitlements", () => {
  it("stacks unlimited periods and lets support revoke one", async () => {
    const ws = await connected();
    const first = await shopifyIntent(ws, { credits: 0, unlimited: 30 });
    const second = await shopifyIntent(ws, { credits: 0, unlimited: 30 });
    await grantIntent(first.charge);
    await grantIntent(second.charge);
    const rows = await q("select id, starts_at, ends_at from public.credit_entitlements where workspace_id = $1 order by starts_at", [ws.id]);
    expect(rows).toHaveLength(2);
    expect(rows[1].starts_at.getTime()).toBe(rows[0].ends_at.getTime());
    await expect(q("update public.credit_entitlements set ends_at = ends_at + interval '1 year' where id = $1", [rows[0].id])).rejects.toThrow(/only_by_revocation/);
    expect(await call("revoke_credit_entitlement", rows[0].id, "support_test", "refund")).toBe(true);
    expect((await call("workspace_credit_status", ws.id, ws.owner)).is_unlimited).toBe(false);
  });
});

describe("legacy opening balances", () => {
  async function legacy({ credits = 6, payments = [5], usage = 0, free = true, unlimitedDays = 0 } = {}) {
    const owner = user();
    const [row] = await q(`insert into public.user_integrations (clerk_user_id, credits, credits_balance, free_credit_used, credits_unlimited_until)
      values ($1, $2, $2, $3, ${unlimitedDays ? `now() + interval '${unlimitedDays} days'` : "null"}) returning id`, [owner, credits, free]);
    for (const granted of payments) {
      await q("insert into public.payments (clerk_user_id, provider, pack, currency, credits_granted, status) values ($1, 'shopify', 'starter', 'USD', $2, 'success')", [owner, granted]);
    }
    if (usage) await q("insert into public.credit_usage (clerk_user_id, credits_used, action) values ($1, $2, 'brief_generated')", [owner, usage]);
    const registered = await q("select public.register_legacy_account($1, $2, null) as r", [row.id, owner]);
    created.push(registered[0].r.workspace_id);
    return { owner, row: row.id, workspace: registered[0].r.workspace_id };
  }
  const open = async (ws) => (await q("select public.open_legacy_credit_balance($1) as r", [ws]))[0].r;

  it("opens the legacy balance once into the legacy workspace, leaving the legacy row untouched", async () => {
    const l = await legacy({ credits: 6, payments: [5], free: true });
    const first = await open(l.workspace);
    expect(first).toMatchObject({ outcome: "applied", balance: 6, needs_review: false });
    expect((await open(l.workspace)).outcome).toBe("duplicate");
    expect(await balance(l.workspace)).toBe(6);
    expect((await q("select credits, credits_balance from public.user_integrations where id = $1", [l.row]))[0]).toEqual({ credits: 6, credits_balance: 6 });
    expect((await q("select count(*)::int n from public.credit_opening_reviews where legacy_user_integration_id = $1", [l.row]))[0].n).toBe(0);
  });

  it("keeps an unexplained balance as is and queues it for review", async () => {
    const l = await legacy({ credits: 9, payments: [5], usage: 1, free: true });
    const result = await open(l.workspace);
    expect(result.needs_review).toBe(true);
    expect(await balance(l.workspace)).toBe(9);
    const [review] = await q("select legacy_balance, explained_balance, difference, status from public.credit_opening_reviews where legacy_user_integration_id = $1", [l.row]);
    expect(review).toEqual({ legacy_balance: 9, explained_balance: 5, difference: 4, status: "open" });
  });

  it("never opens a legacy balance into any other workspace", async () => {
    const l = await legacy();
    const fresh = await connected(l.owner);
    await expect(open(fresh.id)).rejects.toThrow(/not_a_legacy_workspace/);
    expect(await balance(fresh)).toBe(0);
  });

  it("carries legacy unlimited access as an entitlement and withholds a second free credit", async () => {
    const l = await legacy({ credits: 0, payments: [], free: true, unlimitedDays: 10 });
    await open(l.workspace);
    expect((await call("workspace_credit_status", l.workspace, l.owner)).is_unlimited).toBe(true);
    const shop = await newShop();
    await bindAt(shop, { id: l.workspace, owner: l.owner });
    expect((await call("grant_workspace_free_credit", l.workspace, l.owner)).outcome).toBe("legacy_free_credit_used");
  });

  it("reports every legacy row without writing anything", async () => {
    const l = await legacy({ credits: 2, payments: [], free: true });
    const report = await call("legacy_credit_reconciliation_report");
    const mine = report.find((r) => r.legacy_row_id === l.row);
    expect(mine).toMatchObject({ legacy_balance: 2, explained_balance: 1, difference: 1 });
    expect(await entries(l.workspace)).toEqual([]);
  });
});

describe("billing reconciliation cursor", () => {
  it("moves forward only from the cursor it read", async () => {
    const ws = await connected();
    expect(await call("save_billing_cursor", ws.shop, null, "c1", false, null)).toBe(true);
    expect(await call("save_billing_cursor", ws.shop, null, "stale", false, null)).toBe(false);
    expect(await call("save_billing_cursor", ws.shop, "c1", "c2", true, null)).toBe(true);
    expect((await q("select cursor, last_completed_at is not null done from public.billing_sync_state where shop_id = $1", [ws.shop]))[0]).toEqual({ cursor: "c2", done: true });
  });
});
