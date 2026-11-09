/**
 * Real Postgres tests for workspaces and shop bindings (Phase 1, task 3).
 * Every workspace function is called as service_role, the role the app uses,
 * against a throwaway database with synthetic shops and users only.
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
afterAll(() => pool.end());

/** Fixtures and inspection, as the database owner. */
const q = async (sql, params) => (await pool.query(sql, params)).rows;

/** One statement as service_role, in its own transaction, as the app runs it. */
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

async function call(fn, ...args) {
  const [row] = await asService(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args);
  return row.result;
}

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const user = () => `user_test_${tag()}`;
const domain = () => `t-${tag()}.myshopify.com`;
const shopId = () => String(Math.floor(Math.random() * 9e12) + 1e12);
const dbNow = async () => (await q("select clock_timestamp()::text as t"))[0].t;

async function install({ actor = user(), id = shopId(), shop = domain(), selected = null } = {}) {
  const result = await call("bind_shop_for_install", id, shop, actor, selected, "Test shop");
  return { actor, id, shop, result, workspace: result.workspace_id };
}
const bind = (s, actor) => call("bind_shop_for_install", s.id, s.shop, actor, null, null);
const uninstall = async (s, { key = randomUUID(), at } = {}) => call("begin_uninstall", s.id, s.shop, key, at ?? (await dbNow()));
const redact = async (s, { key = randomUUID(), at } = {}) => call("record_shop_redact", s.id, s.shop, key, at ?? (await dbNow()));

const workspace = async (id) => (await q("select * from public.workspaces where id = $1", [id]))[0];
const workspaceCount = async (owner) => (await q("select count(*)::int as n from public.workspaces where owner_clerk_user_id = $1", [owner]))[0].n;
const currentBinding = async (shop) =>
  (await q("select b.* from public.shop_bindings b join public.shops s on s.id = b.shop_id where s.myshopify_domain = $1 and b.released_at is null", [shop]))[0];
const events = async (ws) => (await q("select event from public.workspace_events where workspace_id = $1 order by id", [ws])).map((row) => row.event);
const setBalance = (ws, balance) => q("update public.credit_accounts set balance = $2 where workspace_id = $1", [ws, balance]);
const emptyWorkspace = async (owner) => (await q("insert into public.workspaces (owner_clerk_user_id) values ($1) returning id", [owner]))[0].id;
const campaign = async (creator, ws, store = null) =>
  (await q("insert into public.campaigns (clerk_user_id, product_name, workspace_id, brief_data) values ($1, 'Lamp', $2, $3) returning id", [
    creator, ws, store ? { storeInsights: { store: { myshopify_domain: store } } } : null,
  ]))[0].id;
const legacyRow = (actor, shop) =>
  q(`insert into public.user_integrations (clerk_user_id, credits, credits_balance, free_credit_used, shop_domain, shopify_store_url, shopify_access_token, access_token, store_snapshot)
     values ($1, 0, 0, false, $2, $2, 'shpat_synthetic', 'shpat_synthetic', $3)`, [actor, shop, { store: { domain: shop } }]);

describe("provisioning", () => {
  it("binds a first installation to a new workspace with its own credit account", async () => {
    const s = await install();
    expect(s.result.outcome).toBe("bound_new_workspace");
    expect(await workspace(s.workspace)).toMatchObject({ owner_clerk_user_id: s.actor, status: "active" });
    expect((await currentBinding(s.shop)).workspace_id).toBe(s.workspace);
    expect(await q("select balance from public.credit_accounts where workspace_id = $1", [s.workspace])).toEqual([{ balance: 0 }]);
    expect(await events(s.workspace)).toEqual(["provisioned", "connected"]);
  });

  it("treats a repeated callback as the same installation", async () => {
    const s = await install();
    expect(await bind(s, s.actor)).toMatchObject({ outcome: "already_bound", workspace_id: s.workspace });
    expect(await workspaceCount(s.actor)).toBe(1);
  });

  it("creates one workspace and one binding when ten callbacks race", async () => {
    const s = { id: shopId(), shop: domain() };
    const actor = user();
    const results = await Promise.all(Array.from({ length: 10 }, () => bind(s, actor)));
    expect(results.filter((r) => r.outcome === "bound_new_workspace")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already_bound")).toHaveLength(9);
    expect(new Set(results.map((r) => r.workspace_id)).size).toBe(1);
    expect(await workspaceCount(actor)).toBe(1);
  });

  it("lets exactly one of two accounts racing for a shop win", async () => {
    const s = { id: shopId(), shop: domain() };
    const [a, b] = [user(), user()];
    const outcomes = (await Promise.all([a, b, a, b].map((actor) => bind(s, actor)))).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["already_bound", "bound_new_workspace", "rejected_other_owner", "rejected_other_owner"]);
    expect((await workspaceCount(a)) + (await workspaceCount(b))).toBe(1);
  });

  it("rejects a shop bound to another workspace without changing the binding", async () => {
    const s = await install();
    const intruder = user();
    const before = await currentBinding(s.shop);
    expect(await call("shop_connection_preflight", s.shop, intruder)).toEqual({ outcome: "rejected_other_owner" });
    expect((await bind(s, intruder)).outcome).toBe("rejected_other_owner");
    expect(await currentBinding(s.shop)).toEqual(before);
    expect(await workspaceCount(intruder)).toBe(0);
    expect(await events(s.workspace)).toContain("connect_rejected");
  });

  it("gives one user a separate workspace and credit account per shop", async () => {
    const first = await install();
    const second = await install({ actor: first.actor });
    expect(second.result.outcome).toBe("bound_new_workspace");
    expect(second.workspace).not.toBe(first.workspace);
    await setBalance(first.workspace, 5);
    expect(await call("workspace_credit_balance", first.workspace, first.actor)).toBe(5);
    expect(await call("workspace_credit_balance", second.workspace, first.actor)).toBe(0);
    expect((await call("list_workspaces", first.actor)).map((w) => w.shop_domain).sort()).toEqual([first.shop, second.shop].sort());
  });

  it("binds into a chosen workspace only when it is the actor's, active and unbound", async () => {
    const actor = user();
    const empty = await emptyWorkspace(actor);
    expect((await install({ actor, selected: await emptyWorkspace(user()) })).result.outcome).toBe("rejected_workspace_ineligible");
    expect((await install({ actor, selected: empty })).result).toMatchObject({ outcome: "bound_existing_workspace", workspace_id: empty });
    expect((await install({ actor, selected: empty })).result.outcome).toBe("rejected_workspace_ineligible");
  });

  it("follows a domain change by Shopify ID and refuses a domain held by another shop", async () => {
    const s = await install();
    const renamed = domain();
    expect((await call("bind_shop_for_install", s.id, renamed, s.actor, null, null)).outcome).toBe("already_bound");
    const [shop] = await q("select myshopify_domain, domain_changed_at from public.shops where shopify_shop_id = $1", [s.id]);
    expect(shop.myshopify_domain).toBe(renamed);
    expect(shop.domain_changed_at).not.toBeNull();
    expect((await call("bind_shop_for_install", shopId(), renamed, s.actor, null, null)).outcome).toBe("rejected_identity_conflict");
  });
});

describe("database constraints", () => {
  it("allows one current binding per shop and per workspace, and one shop per Shopify ID", async () => {
    const s = await install();
    const [{ id: shopRow }] = await q("select id from public.shops where shopify_shop_id = $1", [s.id]);
    const insertBinding = (shop, ws) => q("insert into public.shop_bindings (shop_id, workspace_id, bound_by_clerk_user_id) values ($1, $2, 'fixture')", [shop, ws]);
    await expect(insertBinding(shopRow, await emptyWorkspace(s.actor))).rejects.toThrow("shop_bindings_current_shop");
    const [{ id: otherShop }] = await q("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning id", [shopId(), domain()]);
    await expect(insertBinding(otherShop, s.workspace)).rejects.toThrow("shop_bindings_current_workspace");
    await expect(q("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2)", [s.id, domain()])).rejects.toThrow("shops_shopify_shop_id_key");
    await expect(q("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, 'shop.example.com')", [shopId()])).rejects.toThrow("shops_myshopify_domain_check");
  });

  it("keeps the audit trail append-only", async () => {
    const s = await install();
    await expect(q("update public.workspace_events set event = 'edited' where workspace_id = $1", [s.workspace])).rejects.toThrow("append_only_table");
    await expect(q("delete from public.workspace_events where workspace_id = $1", [s.workspace])).rejects.toThrow("append_only_table");
  });
});

describe("ownership", () => {
  it("restores the same workspace when its owner reconnects after disconnecting", async () => {
    const s = await install();
    await setBalance(s.workspace, 3);
    expect(await call("disconnect_workspace", s.workspace, s.actor)).toMatchObject({ outcome: "disconnected", shop_domain: s.shop });
    expect((await currentBinding(s.shop)).workspace_id).toBe(s.workspace);
    expect(await call("workspace_can_operate", s.workspace)).toBe(false);
    expect(await call("shop_operations_allowed", s.shop)).toBe(false);
    expect(await bind(s, s.actor)).toMatchObject({ outcome: "reconnected", workspace_id: s.workspace });
    expect(await call("workspace_credit_balance", s.workspace, s.actor)).toBe(3);
    expect(await workspaceCount(s.actor)).toBe(1);
    expect(await call("shop_operations_allowed", s.shop)).toBe(true);
  });

  it("refuses a disconnect by anyone but the owner", async () => {
    const s = await install();
    await expect(call("disconnect_workspace", s.workspace, user())).rejects.toThrow("workspace_access_denied");
  });

  it("does not let another account claim a disconnected or pending-deletion shop", async () => {
    const s = await install();
    const other = user();
    await call("disconnect_workspace", s.workspace, s.actor);
    expect((await bind(s, other)).outcome).toBe("rejected_other_owner");
    await uninstall(s);
    expect((await workspace(s.workspace)).status).toBe("pending_deletion");
    expect((await bind(s, other)).outcome).toBe("rejected_other_owner");
    expect(await call("shop_connection_preflight", s.shop, other)).toEqual({ outcome: "rejected_other_owner" });
  });
});

describe("ownership transfer", () => {
  async function requested() {
    const s = await install();
    const requester = user();
    const { transfer_id: transfer } = await call("request_ownership_transfer", s.shop, requester, null, "Bought the business");
    return { s, requester, transfer };
  }

  it("cannot complete without Shopify verification and the current owner's approval", async () => {
    const { s, requester, transfer } = await requested();
    await expect(call("approve_ownership_transfer", transfer, s.actor)).rejects.toThrow("transfer_not_approvable");
    await expect(call("complete_ownership_transfer", transfer, requester, s.id)).rejects.toThrow("transfer_not_approved");
    await expect(call("verify_ownership_transfer", transfer, requester, domain())).rejects.toThrow("transfer_shop_mismatch");
    await expect(call("verify_ownership_transfer", transfer, user(), s.shop)).rejects.toThrow("transfer_access_denied");
    await call("verify_ownership_transfer", transfer, requester, s.shop);
    await expect(call("complete_ownership_transfer", transfer, requester, s.id)).rejects.toThrow("transfer_not_approved");
    await expect(call("approve_ownership_transfer", transfer, requester)).rejects.toThrow("transfer_access_denied");
    await expect(call("approve_ownership_transfer", transfer, user())).rejects.toThrow("transfer_access_denied");
    expect((await currentBinding(s.shop)).workspace_id).toBe(s.workspace);
  });

  it("moves only the binding: credits, campaigns and history stay with the original workspace", async () => {
    const { s, requester, transfer } = await requested();
    await setBalance(s.workspace, 7);
    const lamp = await campaign(s.actor, s.workspace);
    await call("verify_ownership_transfer", transfer, requester, s.shop);
    await call("approve_ownership_transfer", transfer, s.actor);
    const done = await call("complete_ownership_transfer", transfer, requester, s.id);
    expect(done).toMatchObject({ outcome: "completed", previous_workspace_id: s.workspace });

    expect(await currentBinding(s.shop)).toMatchObject({ workspace_id: done.workspace_id, bound_by_clerk_user_id: requester, transfer_id: transfer });
    expect(await q("select release_reason, transfer_id from public.shop_bindings where workspace_id = $1", [s.workspace]))
      .toEqual([{ release_reason: "ownership_transferred", transfer_id: transfer }]);
    expect(await call("workspace_credit_balance", s.workspace, s.actor)).toBe(7);
    expect(await call("workspace_credit_balance", done.workspace_id, requester)).toBe(0);
    expect((await q("select workspace_id from public.campaigns where id = $1", [lamp]))[0].workspace_id).toBe(s.workspace);
    await expect(call("campaign_for_actor", lamp, done.workspace_id, requester)).rejects.toThrow("campaign_not_found");
    await expect(call("workspace_for_actor", s.workspace, requester)).rejects.toThrow("workspace_access_denied");

    const [record] = await q("select * from public.ownership_transfers where id = $1", [transfer]);
    expect(record).toMatchObject({
      status: "completed", requested_by_clerk_user_id: requester, approved_by_clerk_user_id: s.actor,
      from_workspace_id: s.workspace, to_workspace_id: done.workspace_id, reason: "Bought the business",
    });
    expect(record.shopify_verified_at && record.approved_at && record.completed_at).toBeTruthy();
  });

  it("leaves the application role no direct way to move or release a binding", async () => {
    const s = await install();
    await expect(asService("update public.shop_bindings set released_at = now(), release_reason = 'ownership_transferred' where workspace_id = $1", [s.workspace]))
      .rejects.toThrow("permission denied");
    await expect(asService("update public.workspaces set owner_clerk_user_id = 'someone_else' where id = $1", [s.workspace])).rejects.toThrow("permission denied");
  });

  it("allows one open request per shop and cancels it on uninstall", async () => {
    const { s, transfer } = await requested();
    await expect(call("request_ownership_transfer", s.shop, user(), null, null)).rejects.toThrow("transfer_already_open");
    await uninstall(s);
    expect((await q("select status from public.ownership_transfers where id = $1", [transfer]))[0].status).toBe("cancelled");
  });
});

describe("uninstall and reinstall", () => {
  it("stops activity on uninstall, starts the recovery window and keeps the binding", async () => {
    const s = await install();
    expect(await uninstall(s)).toMatchObject({ outcome: "pending_deletion", workspace_id: s.workspace });
    expect((await workspace(s.workspace)).status).toBe("pending_deletion");
    const [{ hours }] = await q("select extract(epoch from recovery_ends_at - uninstalled_at) / 3600 as hours from public.workspaces where id = $1", [s.workspace]);
    expect(Number(hours)).toBe(48);
    expect(await call("workspace_can_operate", s.workspace)).toBe(false);
    expect(await call("shop_operations_allowed", s.shop)).toBe(false);
    expect((await currentBinding(s.shop)).workspace_id).toBe(s.workspace);
    expect(await q(
      `select topic, shopify_shop_id::text as shop_id, triggered_at is not null as triggered, received_at is not null as received, outcome
         from public.shop_lifecycle_events where workspace_id = $1`, [s.workspace],
    )).toEqual([{ topic: "app/uninstalled", shop_id: s.id, triggered: true, received: true, outcome: "pending_deletion" }]);
  });

  it("restores the original workspace on reinstall before redaction", async () => {
    const s = await install();
    await setBalance(s.workspace, 4);
    await uninstall(s);
    expect(await bind(s, s.actor)).toMatchObject({ outcome: "restored", workspace_id: s.workspace });
    const ws = await workspace(s.workspace);
    expect(ws).toMatchObject({ status: "active", recovery_ends_at: null, deletion_requested_at: null });
    expect(ws.uninstalled_at).not.toBeNull();
    expect(await call("workspace_credit_balance", s.workspace, s.actor)).toBe(4);
  });

  it("processes a repeated uninstall delivery once", async () => {
    const s = await install();
    const key = randomUUID();
    expect((await uninstall(s, { key })).outcome).toBe("pending_deletion");
    expect(await uninstall(s, { key })).toEqual({ outcome: "duplicate", recorded_outcome: "pending_deletion" });
    expect(await q("select count(*)::int as n from public.shop_lifecycle_events where event_key = $1", [key])).toEqual([{ n: 1 }]);
  });

  it("ignores an uninstall Shopify triggered before the latest reconnection", async () => {
    const s = await install();
    const [{ t: earlier }] = await q("select (clock_timestamp() - interval '5 minutes')::text as t");
    expect((await uninstall(s, { at: earlier })).outcome).toBe("stale");
    expect((await workspace(s.workspace)).status).toBe("active");
    expect(await events(s.workspace)).toContain("uninstall_stale");
  });

  it("records an uninstall that arrives after redaction began without undoing the deletion", async () => {
    const s = await install();
    await redact(s);
    expect((await uninstall(s)).outcome).toBe("already_deleting");
    expect((await workspace(s.workspace)).status).toBe("deletion_processing");
  });

  it("records an uninstall for a shop with no workspace", async () => {
    expect(await uninstall({ id: shopId(), shop: domain() })).toMatchObject({ outcome: "no_workspace" });
  });
});

describe("shop redaction", () => {
  it("records the request with its deadline, deletes, verifies, then releases the shop", async () => {
    const s = await install();
    await legacyRow(s.actor, s.shop);
    await q("insert into public.capi_events (clerk_user_id, shopify_order_id, shop_domain) values ($1, '1001', $2)", [s.actor, s.shop]);
    await q("insert into public.webhook_deliveries (shop_domain, webhook_id, topic) values ($1, $2, 'orders/paid')", [s.shop, randomUUID()]);
    await campaign(s.actor, s.workspace);
    await uninstall(s);

    const started = await redact(s);
    expect(started).toMatchObject({ outcome: "deletion_started", workspace_id: s.workspace });
    expect((await q("select status, extract(day from due_at - received_at)::int as days from public.compliance_requests where id = $1", [started.compliance_request_id]))[0])
      .toEqual({ status: "processing", days: 30 });
    expect((await bind(s, s.actor)).outcome).toBe("rejected_deletion_in_progress");

    const done = await call("process_workspace_deletion", started.deletion_id);
    expect(done).toMatchObject({
      outcome: "completed",
      verification: { integration_rows_naming_shop: 0, workspace_campaigns: 0, capi_events: 0, webhook_deliveries: 0 },
    });
    expect((await workspace(s.workspace)).status).toBe("deleted");
    await expect(call("workspace_for_actor", s.workspace, s.actor)).rejects.toThrow("workspace_access_denied");
    expect(await currentBinding(s.shop)).toBeUndefined();
    expect(await q("select release_reason from public.shop_bindings where workspace_id = $1", [s.workspace])).toEqual([{ release_reason: "deletion_completed" }]);
    expect((await q("select status, resolution from public.compliance_requests where id = $1", [started.compliance_request_id]))[0])
      .toEqual({ status: "completed", resolution: "shop_data_deleted" });
    expect(await call("process_workspace_deletion", started.deletion_id)).toMatchObject({ outcome: "completed" });

    const fresh = await bind(s, s.actor);
    expect(fresh.outcome).toBe("bound_new_workspace");
    expect(fresh.workspace_id).not.toBe(s.workspace);
  });

  it("acts on a redaction that arrives after the merchant reinstalled", async () => {
    const s = await install();
    await uninstall(s);
    expect((await bind(s, s.actor)).outcome).toBe("restored");
    expect((await redact(s)).outcome).toBe("deletion_started");
    expect(await events(s.workspace)).toEqual(expect.arrayContaining(["redact_after_reinstall", "redact_received", "deletion_started"]));
    expect(await call("shop_connection_preflight", s.shop, s.actor)).toEqual({ outcome: "rejected_deletion_in_progress" });
    expect(await call("workspace_can_operate", s.workspace)).toBe(false);
    await expect(call("workspace_for_actor", s.workspace, s.actor)).rejects.toThrow("workspace_access_denied");
  });

  it("processes a repeated redaction delivery once and folds a second request into the running deletion", async () => {
    const s = await install();
    const key = randomUUID();
    const first = await redact(s, { key });
    expect(await redact(s, { key })).toEqual({ outcome: "duplicate", compliance_request_id: first.compliance_request_id, deletion_id: first.deletion_id });
    expect(await redact(s)).toMatchObject({ outcome: "deletion_already_running", deletion_id: first.deletion_id });
    expect(await q("select count(*)::int as n from public.workspace_deletions where workspace_id = $1", [s.workspace])).toEqual([{ n: 1 }]);
    await call("process_workspace_deletion", first.deletion_id);
    expect(await q("select status from public.compliance_requests where workspace_id = $1", [s.workspace])).toEqual([{ status: "completed" }, { status: "completed" }]);
  });

  it("keeps a failed deletion open with its error and completes it on retry", async () => {
    const s = await install();
    await q("insert into public.campaigns (clerk_user_id, product_name, workspace_id) values ($1, 'undeletable', $2)", [s.actor, s.workspace]);
    const started = await redact(s);
    await q(`create function public.test_block_campaign_delete() returns trigger language plpgsql as $$
             begin if old.product_name = 'undeletable' then raise exception 'simulated outage'; end if; return old; end $$`);
    await q("create trigger test_block_campaign_delete before delete on public.campaigns for each row execute function public.test_block_campaign_delete()");
    try {
      expect(await call("process_workspace_deletion", started.deletion_id)).toMatchObject({ outcome: "failed", error: "simulated outage" });
      expect((await q("select status, attempts, last_error from public.workspace_deletions where id = $1", [started.deletion_id]))[0])
        .toEqual({ status: "failed", attempts: 1, last_error: "simulated outage" });
      expect((await workspace(s.workspace)).status).toBe("deletion_processing");
      expect((await currentBinding(s.shop)).workspace_id).toBe(s.workspace);
    } finally {
      await q("drop trigger if exists test_block_campaign_delete on public.campaigns");
      await q("drop function if exists public.test_block_campaign_delete()");
    }
    expect((await call("process_workspace_deletion", started.deletion_id)).outcome).toBe("completed");
    expect((await q("select attempts from public.workspace_deletions where id = $1", [started.deletion_id]))[0].attempts).toBe(2);
  });

  it("never deletes the owner's identity, their other workspaces or anyone else's data", async () => {
    const s = await install();
    const sibling = await install({ actor: s.actor });
    const stranger = await install();
    await legacyRow(s.actor, s.shop);
    const own = await campaign(s.actor, s.workspace);
    const siblings = await campaign(s.actor, sibling.workspace);
    const strangers = await campaign(stranger.actor, stranger.workspace);

    const started = await redact(s);
    expect((await call("process_workspace_deletion", started.deletion_id)).outcome).toBe("completed");
    const left = (await q("select id from public.campaigns where id = any($1)", [[own, siblings, strangers]])).map((row) => row.id).sort();
    expect(left).toEqual([siblings, strangers].sort());
    expect(await q("select count(*)::int as n from public.user_integrations where clerk_user_id = $1", [s.actor])).toEqual([{ n: 1 }]);
    expect((await workspace(sibling.workspace)).status).toBe("active");
    expect((await call("list_workspaces", s.actor)).map((w) => w.workspace_id)).toEqual([sibling.workspace]);
  });

  it("completes a redaction for a shop that never had a workspace, and blocks binding until then", async () => {
    const s = { id: shopId(), shop: domain() };
    const actor = user();
    await legacyRow(actor, s.shop);
    const started = await redact(s);
    expect(started.outcome).toBe("no_workspace");
    expect((await bind(s, actor)).outcome).toBe("rejected_deletion_in_progress");
    expect(await call("process_unbound_shop_redact", started.compliance_request_id)).toEqual({ outcome: "completed" });
    expect((await bind(s, actor)).outcome).toBe("bound_new_workspace");
  });

  it("records customer compliance requests once and resolves them", async () => {
    const key = randomUUID();
    const args = ["customers/data_request", shopId(), domain(), key, await dbNow()];
    expect((await call("record_customer_compliance", ...args)).outcome).toBe("completed");
    expect(await call("record_customer_compliance", ...args)).toEqual({ outcome: "duplicate" });
  });
});

describe("legacy ownership claims", () => {
  const register = (actor, claimed, row = randomUUID()) => call("register_legacy_account", row, actor, claimed);

  it("holds a single claim as provisional until the claimant connects the verified shop", async () => {
    const [actor, other] = [user(), user()];
    const s = { id: shopId(), shop: domain() };
    const row = randomUUID();
    const claim = await register(actor, s.shop, row);
    expect(claim).toMatchObject({ outcome: "registered", status: "provisional" });
    expect(await register(actor, s.shop, row)).toMatchObject({ outcome: "existing", claim_id: claim.claim_id });
    expect(await q("select count(*)::int as n from public.shops where myshopify_domain = $1", [s.shop])).toEqual([{ n: 0 }]);

    expect(await call("shop_connection_preflight", s.shop, other)).toEqual({ outcome: "rejected_legacy_claim" });
    expect((await bind(s, other)).outcome).toBe("rejected_legacy_claim");
    expect(await bind(s, actor)).toMatchObject({ outcome: "bound_existing_workspace", workspace_id: claim.workspace_id });
    expect((await q("select status, shop_id is not null as has_shop from public.legacy_shop_claims where id = $1", [claim.claim_id]))[0])
      .toEqual({ status: "confirmed", has_shop: true });
  });

  it("blocks automatic assignment when several accounts claim one store, until review", async () => {
    const [a, b] = [user(), user()];
    const s = { id: shopId(), shop: domain() };
    const first = await register(a, s.shop);
    const second = await register(b, s.shop);
    expect(second.status).toBe("contested");
    expect(await q("select status from public.legacy_shop_claims where id = $1", [first.claim_id])).toEqual([{ status: "contested" }]);
    for (const actor of [a, b]) {
      expect(await call("shop_connection_preflight", s.shop, actor)).toEqual({ outcome: "rejected_legacy_claim_under_review" });
      expect((await bind(s, actor)).outcome).toBe("rejected_legacy_claim_under_review");
    }
    await expect(call("review_legacy_claims", s.shop, first.claim_id, "support", "")).rejects.toThrow("review_details_required");
    await call("review_legacy_claims", s.shop, first.claim_id, "support", "Shopify staff list names this account's owner");
    expect(await q("select status from public.legacy_shop_claims where id = $1", [second.claim_id])).toEqual([{ status: "rejected" }]);
    expect((await bind(s, b)).outcome).toBe("rejected_legacy_claim");
    expect(await bind(s, a)).toMatchObject({ outcome: "bound_existing_workspace", workspace_id: first.workspace_id });
  });

  it("marks a missing or invalid identity unresolved and never binds it", async () => {
    for (const claimed of [null, "", "not a shop", "shop.example.com"]) {
      expect((await register(user(), claimed)).status, String(claimed)).toBe("unresolved");
    }
    expect(await call("bind_shop_for_install", null, domain(), user(), null, null)).toEqual({ outcome: "rejected_invalid_identity" });
    expect(await call("bind_shop_for_install", shopId(), "shop.example.com", user(), null, null)).toEqual({ outcome: "rejected_invalid_identity" });
    expect(await call("shop_connection_preflight", "shop.example.com", user())).toEqual({ outcome: "rejected_invalid_identity" });
  });

  it("never confirms a claim from its domain alone", async () => {
    const claim = await register(user(), domain());
    expect(await q("select count(*)::int as n from public.shop_bindings where workspace_id = $1", [claim.workspace_id])).toEqual([{ n: 0 }]);
    await expect(q("update public.legacy_shop_claims set status = 'confirmed' where id = $1", [claim.claim_id])).rejects.toThrow("legacy_shop_claims_confirmation");
  });
});

describe("tenant isolation and access", () => {
  it("denies another user's workspace, balance and campaigns, and keeps campaigns with their creator", async () => {
    const s = await install();
    const other = user();
    const lamp = await campaign(s.actor, s.workspace);
    await expect(call("workspace_for_actor", s.workspace, other)).rejects.toThrow("workspace_access_denied");
    await expect(call("workspace_credit_balance", s.workspace, other)).rejects.toThrow("workspace_access_denied");
    await expect(call("campaign_for_actor", lamp, s.workspace, other)).rejects.toThrow("workspace_access_denied");
    expect(await call("campaign_for_actor", lamp, s.workspace, s.actor)).toMatchObject({ id: lamp });
    const sibling = await install({ actor: s.actor });
    await expect(call("campaign_for_actor", lamp, sibling.workspace, s.actor)).rejects.toThrow("campaign_not_found");
    const someoneElses = await campaign(other, s.workspace);
    await expect(call("campaign_for_actor", someoneElses, s.workspace, s.actor)).rejects.toThrow("campaign_not_found");
    expect(await call("list_workspaces", other)).toEqual([]);
  });

  it("gives client roles nothing, and the application role reads plus the workspace functions only", async () => {
    const tables = ["workspaces", "credit_accounts", "shops", "shop_bindings", "workspace_events", "shop_lifecycle_events",
      "compliance_requests", "workspace_deletions", "ownership_transfers", "legacy_shop_claims"];
    for (const table of tables) {
      const [row] = await q(
        `select has_table_privilege('anon', $1, 'select') as anon, has_table_privilege('authenticated', $1, 'select') as authed,
                has_table_privilege('service_role', $1, 'select') as read, has_table_privilege('service_role', $1, 'insert,update,delete,truncate') as write,
                (select relrowsecurity from pg_class where oid = $1::regclass) as rls`, [`public.${table}`],
      );
      expect(row, table).toEqual({ anon: false, authed: false, read: true, write: false, rls: true });
    }
    const privilege = async (fn) => (await q(
      `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as authed,
              has_function_privilege('service_role', $1, 'execute') as service`, [`public.${fn}`]))[0];
    for (const fn of ["log_workspace_event(uuid,uuid,text,text,text,timestamptz,jsonb)", "find_shop(bigint,text)", "shop_has_open_redaction(bigint,text)"]) {
      expect(await privilege(fn), fn).toEqual({ anon: false, authed: false, service: false });
    }
    for (const fn of ["bind_shop_for_install(bigint,text,text,uuid,text)", "begin_uninstall(bigint,text,text,timestamptz)", "workspace_for_actor(uuid,text)"]) {
      expect(await privilege(fn), fn).toEqual({ anon: false, authed: false, service: true });
    }
  });
});
