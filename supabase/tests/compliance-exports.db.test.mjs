/**
 * Customer data requests and redaction across every write path (Phase 2,
 * task 9; decisions 4 and 5; migration 0037). Synthetic rows only, written
 * through the ingestion RPCs as imports and webhooks write them.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 6 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

/** An RPC as the app calls it, as service_role. Arguments go as given (JSON payloads already stringified). */
async function call(fn, ...args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args);
    await client.query("commit");
    return rows[0].result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function rowsOf(fn, ...args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(`select * from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
    await client.query("commit");
    return rows;
  } finally {
    client.release();
  }
}
const json = (value) => JSON.stringify(value);

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function boundShop() {
  const shop = `ce-${tag()}.myshopify.com`;
  const shopify = Math.floor(Math.random() * 9e12) + 1e12;
  const owner = `user_${tag()}`;
  const installed = await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop') as r", [shopify, shop, owner]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key, owner, workspace: installed.r.workspace_id };
}
const KEY = randomBytes(32);
const digestHex = (s, type, id) => createHmac("sha256", KEY).update(`${s.shopify}:${type}:${id}`).digest("hex");
const digest = (s, type, id) => Buffer.from(digestHex(s, type, id), "hex");
const dbNow = async () => (await one("select clock_timestamp()::text as t")).t;
const recent = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Customer 501's orders 11 and 12, customer 502's order 21, a refund, a return, a Meta send log and an inbox payload. */
async function seededShop() {
  const s = await boundShop();
  const order = (id, customer, at) => ({
    shopify_id: id, shopify_created_at: at, processed_at: at, currency: "GBP", subtotal: 20, total_price: 25, total_refunded: id === 12 ? 5 : 0,
    customer_shopify_id: customer, ship_country_code: "GB", ship_city: "Leeds", shopify_updated_at: at,
    customer_digest: customer ? digestHex(s, "customer", customer) : null, order_digest: digestHex(s, "order", id),
  });
  const line = (id, orderId) => ({ shopify_id: id, order_shopify_id: orderId, product_shopify_id: 7, quantity: 1, unit_price: 20, refunded_quantity: 0 });
  await call("ingest_customers", s.key, json([
    { shopify_id: 501, orders_count: 2, digest: digestHex(s, "customer", 501) },
    { shopify_id: 502, orders_count: 1, digest: digestHex(s, "customer", 502) },
  ]));
  await call("ingest_orders", s.key, json([order(11, 501, recent(20)), order(12, 501, recent(10)), order(21, 502, recent(5))]),
    json([line(111, 11), line(121, 12), line(211, 21)]),
    json([{ shopify_id: 1201, order_shopify_id: 12, shopify_created_at: recent(9), total_refunded: 5, currency: "GBP" }]));
  await call("ingest_returns", s.key, json([{ shopify_id: 1202, order_shopify_id: 12, status: "closed", total_quantity: 1, shopify_created_at: recent(8) }]),
    json([{ shopify_id: 1203, return_shopify_id: 1202, line_item_shopify_id: 121, quantity: 1, return_reason: "defective" }]));
  await q(`insert into public.capi_events (shop_domain, shopify_order_id, order_value, currency, status, event_type) values ($1, '11', 25, 'GBP', 'sent', 'Purchase'), ($1, '21', 25, 'GBP', 'sent', 'Purchase')`, [s.shop]);
  await q(`insert into public.webhook_events (shop_domain, shop_key, webhook_id, topic, payload) values ($1, $2, $3, 'orders/updated', $4)`, [s.shop, s.key, randomUUID(), json({ id: 12, customer: { id: 501 } })]);
  return s;
}
const dataRequest = (s, customer, orders = "{}") =>
  call("record_customer_compliance", "customers/data_request", s.shopify, s.shop, randomUUID(), new Date(), customer, orders, null, null, 1);
const redact = (s, customer, orders = []) =>
  call("record_customer_compliance", "customers/redact", s.shopify, s.shop, randomUUID(), new Date(), customer, `{${orders.join(",")}}`,
    digest(s, "customer", customer), orders.map((id) => digest(s, "order", id)), 1);
const exportRow = (requestId) => one("select * from public.compliance_exports where request_id = $1", [requestId]);
const fakeFile = () => ({ key: `compliance-exports/${randomUUID()}.bin`, sha: randomBytes(32).toString("hex") });
const record = (requestId, run, file = fakeFile()) =>
  call("record_compliance_export", requestId, run, file.key, 100, file.sha, 1, json({ orders: 2 }));

describe("customer data requests (task 9, decision 4)", () => {
  it("opens an export naming the customer only when data is held", async () => {
    const s = await seededShop();
    const held = await dataRequest(s, 501, "{12}");
    expect(held).toMatchObject({ outcome: "open" });
    expect(await exportRow(held.compliance_request_id)).toMatchObject({
      status: "pending", shop_domain: s.shop, workspace_id: s.workspace, customer_shopify_id: "501", order_ids: ["12"],
    });
    const none = await dataRequest(s, 999);
    expect(none).toMatchObject({ outcome: "completed", resolution: "no_customer_data_held" });
    expect(await exportRow(none.compliance_request_id)).toBeUndefined();
  });

  it("lets only the claiming run read the customer's data, one page at a time, and nothing of anyone else's", async () => {
    const s = await seededShop();
    const { compliance_request_id: id } = await dataRequest(s, 501, "{12}");
    expect(await call("claim_compliance_export", id, "run_a", 900)).toMatchObject({ outcome: "claimed", customer_id: 501, order_ids: [12], shop_key: s.key });
    expect(await call("claim_compliance_export", id, "run_b", 900)).toEqual({ outcome: "busy" });

    const customer = await call("compliance_export_customer", id, "run_a");
    expect(customer).toMatchObject({ shopify_id: 501, orders_count: 2 });
    expect(customer).not.toHaveProperty("shop_key");
    await expect(call("compliance_export_customer", id, "run_b")).rejects.toThrow(/export_not_claimed/);

    const first = await call("compliance_export_orders", id, "run_a", 0, 1);
    expect(first.orders.map((o) => o.shopify_id)).toEqual([11]);
    expect(first.next_after).toBe(11);
    const second = await call("compliance_export_orders", id, "run_a", 11, 1);
    expect(second.orders[0]).toMatchObject({
      shopify_id: 12, ship_city: "Leeds", line_items: [expect.objectContaining({ shopify_id: 121 })],
      refunds: [expect.objectContaining({ shopify_id: 1201 })],
      returns: [expect.objectContaining({ shopify_id: 1202, line_items: [expect.objectContaining({ shopify_id: 1203, quantity: 1 })] })],
    });
    expect((await call("compliance_export_orders", id, "run_a", 12, 1))).toEqual({ orders: [], next_after: null });

    const related = await call("compliance_export_related", id, "run_a");
    expect(related.meta_conversion_events).toEqual([expect.objectContaining({ order_id: "11", event_type: "Purchase" })]);
    expect(related.pending_webhook_payloads).toEqual([expect.objectContaining({ topic: "orders/updated", payload: { id: 12, customer: { id: 501 } } })]);
  });

  it("records the file, completes the request once the owner is told, and lets only the owner download it while it lasts", async () => {
    const s = await seededShop();
    const { compliance_request_id: id } = await dataRequest(s, 501);
    await call("claim_compliance_export", id, "run_a", 900);
    expect(await record(id, "run_b")).toEqual({ outcome: "lost" });
    const file = fakeFile();
    expect(await record(id, "run_a", file)).toMatchObject({ outcome: "ready", owner_clerk_user_id: s.owner, shop_domain: s.shop });
    expect(await one("select status from public.compliance_requests where id = $1", [id])).toEqual({ status: "open" });
    expect(await call("mark_compliance_export_notified", id)).toEqual({ outcome: "notified" });
    expect(await one("select status, resolution from public.compliance_requests where id = $1", [id])).toEqual({ status: "completed", resolution: "customer_data_provided" });

    expect(await call("authorize_compliance_download", id, s.owner)).toMatchObject({ outcome: "authorized", object_key: file.key, sha256: file.sha, key_version: 1 });
    expect(await call("authorize_compliance_download", id, "user_someone_else")).toEqual({ outcome: "not_found" });
    expect((await exportRow(id)).download_count).toBe(1);
    expect(await rowsOf("compliance_exports_for_owner", s.owner, s.workspace)).toEqual([expect.objectContaining({ request_id: id, status: "ready" })]);
    expect(await rowsOf("compliance_exports_for_owner", "user_someone_else", s.workspace)).toEqual([]);

    await q("update public.compliance_exports set expires_at = now() - interval '1 minute' where request_id = $1", [id]);
    expect(await call("authorize_compliance_download", id, s.owner)).toEqual({ outcome: "not_found" });
    expect((await rowsOf("compliance_exports_due", 900, 10, 1000)).filter((a) => a.request_id === id).map((a) => a.action)).toEqual(["expire"]);
    expect(await call("close_compliance_export", id, "expired")).toEqual({ outcome: "closed" });
    expect(await exportRow(id)).toMatchObject({ status: "expired", customer_shopify_id: null, order_ids: [], object_key: file.key });
    expect((await rowsOf("compliance_exports_due", 900, 10, 1000)).filter((a) => a.request_id === id).map((a) => a.action)).toEqual(["delete_file"]);
    expect(await call("compliance_export_file_deleted", id, file.key)).toEqual({ outcome: "deleted" });
    expect((await exportRow(id)).object_key).toBeNull();
  });

  it("dispatches, re-dispatches stalled exports, and escalates each deadline level once", async () => {
    const s = await seededShop();
    const { compliance_request_id: id } = await dataRequest(s, 501);
    const due = async () => (await rowsOf("compliance_exports_due", 900, 10, 1000)).filter((a) => a.request_id === id).map((a) => [a.action, a.level]);
    expect(await due()).toEqual([["dispatch", null]]);
    await call("mark_compliance_export_dispatched", id, "run_1");
    expect(await due()).toEqual([]);

    await q("update public.compliance_requests set due_at = now() + interval '5 days' where id = $1", [id]);
    expect(await due()).toEqual([["escalate", 1]]);
    await call("mark_compliance_escalated", id, 1);
    expect(await due()).toEqual([]);
    await q("update public.compliance_requests set due_at = now() - interval '1 hour' where id = $1", [id]);
    expect(await due()).toEqual([["escalate", 3]]);
    await call("mark_compliance_escalated", id, 3);
    expect(await call("mark_compliance_escalated", id, 2)).toEqual({ outcome: "unchanged" });

    // A run that claimed and went quiet is dispatched again.
    await call("claim_compliance_export", id, "run_1", 900);
    await q("update public.compliance_exports set claimed_at = now() - interval '20 minutes', dispatched_at = now() - interval '20 minutes' where request_id = $1", [id]);
    expect(await due()).toEqual([["dispatch", null]]);
    expect(await call("claim_compliance_export", id, "run_2", 900)).toMatchObject({ outcome: "claimed" });
  });
});

describe("redaction on every write path (task 9, decision 5)", () => {
  it("customers/redact withdraws the customer's export, deletes their Meta logs, and a running or retried export can neither read nor record", async () => {
    const s = await seededShop();
    const { compliance_request_id: id } = await dataRequest(s, 501);
    await call("claim_compliance_export", id, "run_a", 900);
    const result = await redact(s, 501, [11]);
    expect(result.redacted).toMatchObject({ customers: 1, meta_events: 1, exports_withdrawn: 1 });
    expect(await exportRow(id)).toMatchObject({ status: "withdrawn", close_reason: "customer_redacted", customer_shopify_id: null, order_ids: [] });
    expect(await one("select count(*)::int as n from public.capi_events where shop_domain = $1", [s.shop])).toEqual({ n: 1 });

    await expect(call("compliance_export_customer", id, "run_a")).rejects.toThrow(/export_not_claimed/);
    expect(await record(id, "run_a")).toEqual({ outcome: "withdrawn" });
    expect(await call("claim_compliance_export", id, "run_retry", 900)).toEqual({ outcome: "withdrawn" });
    expect(await call("authorize_compliance_download", id, s.owner)).toEqual({ outcome: "not_found" });

    // A ready export's file is named for deletion.
    const other = await seededShop();
    const { compliance_request_id: ready } = await dataRequest(other, 501);
    await call("claim_compliance_export", ready, "run_r", 900);
    const file = fakeFile();
    await record(ready, "run_r", file);
    await redact(other, 501);
    expect(await exportRow(ready)).toMatchObject({ status: "withdrawn", object_key: file.key, customer_shopify_id: null });
    expect((await rowsOf("compliance_exports_due", 900, 10, 1000)).filter((a) => a.request_id === ready).map((a) => a.action)).toEqual(["delete_file"]);
  });

  it("after customers/redact, a re-import, a bulk history file, a webhook replay and a retried task each leave the customer absent", async () => {
    const s = await seededShop();
    const redactEvent = randomUUID();
    await call("record_customer_compliance", "customers/redact", s.shopify, s.shop, redactEvent, new Date(), 501, "{11,12}",
      digest(s, "customer", 501), [digest(s, "order", 11), digest(s, "order", 12)], 1);
    const absent = async () => one(
      `select (select count(*) from public.customers where shop_key = $1 and shopify_id = 501)::int as customers,
              (select count(*) from public.orders where shop_key = $1 and (customer_shopify_id = 501 or (shopify_id in (11, 12) and ship_city is not null)))::int as orders`, [s.key]);
    expect(await absent()).toEqual({ customers: 0, orders: 0 });

    // Re-import (initial import or reconcile): customers and orders come back from Shopify.
    expect(await call("ingest_customers", s.key, json([{ shopify_id: 501, orders_count: 2, digest: digestHex(s, "customer", 501) }]))).toMatchObject({ suppressed: 1 });
    await call("ingest_orders", s.key, json([{
      shopify_id: 11, shopify_created_at: recent(20), processed_at: recent(20), currency: "GBP", total_price: 25, customer_shopify_id: 501,
      ship_city: "Leeds", shopify_updated_at: new Date().toISOString(), customer_digest: digestHex(s, "customer", 501), order_digest: digestHex(s, "order", 11),
    }]), json([]), json([]));
    await call("derive_customer_order_facts", s.key, 0, 2000);
    expect(await absent()).toEqual({ customers: 0, orders: 0 });

    // A historical bulk operation: an old order of the customer is staged without them.
    const { import_id: importId } = await call("request_shop_import", s.key);
    await call("claim_shop_import", importId, "run_hist", 900);
    const old = (await one("select (public.retention_window_start() - interval '2 months')::text as t")).t;
    await call("stage_history_orders", importId, "run_hist",
      json([{ shopify_id: 5, processed_at: old, currency: "GBP", total_price: 10, customer_shopify_id: 501, customer_digest: digestHex(s, "customer", 501), order_digest: digestHex(s, "order", 5) }]),
      json([]));
    expect(await one("select customer_digest from public.history_stage_orders where import_id = $1", [importId])).toEqual({ customer_digest: null });

    // Webhook replays: the same redaction is recognised; a data request now finds nothing held.
    expect(await call("record_customer_compliance", "customers/redact", s.shopify, s.shop, redactEvent, new Date(), 501, "{11,12}", null, null, 1)).toEqual({ outcome: "duplicate" });
    expect(await dataRequest(s, 501, "{11}")).toMatchObject({ outcome: "completed", resolution: "no_customer_data_held" });

    // A retried import task: the import is claimed again and writes again, still without the customer.
    await call("claim_shop_import", importId, "run_hist", 900);
    await call("ingest_customers", s.key, json([{ shopify_id: 501, orders_count: 2, digest: digestHex(s, "customer", 501) }]));
    expect(await absent()).toEqual({ customers: 0, orders: 0 });
  });

  it("after shop/redact, every ingestion path refuses the shop and its exports are withdrawn", async () => {
    const s = await seededShop();
    const { compliance_request_id: exportId } = await dataRequest(s, 501);
    const { import_id: importId } = await call("request_shop_import", s.key);
    await call("claim_shop_import", importId, "run_x", 900);
    await call("finish_shop_import", importId, "run_x", "succeeded", json({ domains: { orders: { status: "succeeded" } } }), null);
    const { import_id: running } = await call("request_shop_import", s.key);
    await call("claim_shop_import", running, "run_y", 900);

    await call("begin_uninstall", s.shopify, s.shop, randomUUID(), await dbNow());
    const started = await call("record_shop_redact", s.shopify, s.shop, randomUUID(), await dbNow());
    expect(await call("process_workspace_deletion", started.deletion_id)).toMatchObject({ outcome: "completed" });

    const month = (await one("select date_trunc('month', now())::date::text as m")).m;
    const refused = [
      ["ingest_catalog", s.key, json([]), json([]), json([])],
      ["ingest_inventory", s.key, json([]), json([])],
      ["ingest_customers", s.key, json([])],
      ["ingest_orders", s.key, json([]), json([]), json([])],
      ["ingest_returns", s.key, json([]), json([])],
      ["derive_customer_order_facts", s.key, 0, 2000],
      ["save_sync_checkpoint", s.key, "orders", null, 1, 0, null],
      ["refresh_summary_month", s.key, month, 1],
      ["maintain_summary_month", s.key, month, 1],
      ["stage_history_orders", running, "run_y", json([]), json([])],
    ];
    for (const [fn, ...args] of refused) {
      await expect(call(fn, ...args), fn).rejects.toThrow(/shop_not_ingestible|import_not_running/);
    }
    expect(await call("request_shop_import", s.key)).toEqual({ outcome: "not_ingestible" });
    expect((await rowsOf("summary_months_due", 5000)).some((row) => row.shop_key === s.key)).toBe(false);

    const actions = (await rowsOf("compliance_exports_due", 900, 10, 1000)).filter((a) => a.request_id === exportId);
    expect(actions).toEqual([expect.objectContaining({ action: "withdraw", reason: "shop_redacted" })]);
    expect(await call("close_compliance_export", exportId, "shop_redacted")).toEqual({ outcome: "closed" });
    expect(await exportRow(exportId)).toMatchObject({ status: "withdrawn", customer_shopify_id: null });
  });
});

describe("privileges", () => {
  it("lets service_role run the export functions, keeps the run check internal, and the exports read-only", async () => {
    for (const [fn, service] of [
      ["claim_compliance_export(uuid, text, integer)", true],
      ["compliance_export_orders(uuid, text, bigint, integer)", true],
      ["record_compliance_export(uuid, text, text, bigint, text, smallint, jsonb)", true],
      ["authorize_compliance_download(uuid, text)", true],
      ["compliance_exports_due(integer, integer, integer)", true],
      ["compliance_export_for_run(uuid, text)", false],
    ]) {
      expect(await one(
        `select has_function_privilege('service_role', $1, 'execute') as service,
                has_function_privilege('anon', $1, 'execute') or has_function_privilege('authenticated', $1, 'execute') as public_exec`, [`public.${fn}`]), fn)
        .toEqual({ service, public_exec: false });
    }
    expect(await one(
      `select c.relrowsecurity as rls, has_table_privilege('service_role', c.oid, 'select') as read,
              has_table_privilege('service_role', c.oid, 'insert') or has_table_privilege('service_role', c.oid, 'update') as write,
              has_table_privilege('anon', c.oid, 'select') as anon
         from pg_class c where c.oid = 'public.compliance_exports'::regclass`)).toEqual({ rls: true, read: true, write: false, anon: false });
  });
});
