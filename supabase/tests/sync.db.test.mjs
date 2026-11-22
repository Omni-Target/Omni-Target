/**
 * Incremental sync inbox and writes (Phase 2, task 10; migration 0040).
 * Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

pg.types.setTypeParser(1082, (value) => value);
const pool = new pg.Pool({ connectionString: url, max: 5 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const json = (value) => JSON.stringify(value);

async function asService(sql, args) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(sql, args);
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
const call = async (fn, ...args) => (await asService(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args))[0].result;
const rowsOf = (fn, ...args) => asService(`select * from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);

let counter = 0;
async function boundShop() {
  const shop = `sy-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}.myshopify.com`;
  const shopify = Math.floor(Math.random() * 9e12) + 1e12;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop') as r", [shopify, shop, `user_${shop}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key };
}
const event = (topic, payload, webhookId = randomUUID()) => ({ webhook_id: webhookId, topic, triggered_at: new Date().toISOString(), payload });
const inbox = (s) => q("select webhook_id, topic, payload, status, attempts, last_error from public.webhook_events where shop_key = $1 order by received_at, webhook_id", [s.key]);

describe("sync inbox (task 10)", () => {
  it("records thin events once each, and only for a shop open for ingestion", async () => {
    const s = await boundShop();
    const recorded = await call("record_sync_events", s.shop, json([
      event("orders/updated", { id: 11, updated_at: "2026-11-22T10:00:00Z", email: "jon@example.com", customer: { id: 501 }, shipping_address: { address1: "1 Main St" } }, "w1"),
      event("orders/paid", { id: 11 }, "w2"),
      event("products/delete", { id: 7 }, "w3"),
    ]));
    expect(recorded).toMatchObject({ outcome: "recorded", recorded: 2 });
    expect(await call("record_sync_events", s.shop, json([event("orders/updated", { id: 11 }, "w1")]))).toMatchObject({ recorded: 0 });
    expect((await inbox(s)).map((e) => [e.webhook_id, e.topic, e.payload])).toEqual([
      ["w1", "orders/updated", { id: 11, updated_at: "2026-11-22T10:00:00Z" }],
      ["w3", "products/delete", { id: 7 }],
    ]);

    // No customer data can be stored, whoever writes.
    await expect(q("insert into public.webhook_events (shop_domain, shop_key, webhook_id, topic, payload) values ($1, $2, $3, 'orders/updated', $4)",
      [s.shop, s.key, randomUUID(), json({ id: 11, customer: { email: "jon@example.com" } })])).rejects.toThrow(/webhook_events_thin_payload/);
    await expect(q("insert into public.webhook_events (shop_domain, shop_key, webhook_id, topic, payload) values ($1, $2, $3, 'orders/updated', $4)",
      [s.shop, s.key, randomUUID(), json({ id: 11, email: "jon@example.com" })])).rejects.toThrow(/webhook_events_thin_payload/);

    await call("begin_uninstall", s.shopify, s.shop, randomUUID(), (await one("select clock_timestamp()::text as t")).t);
    expect(await call("record_sync_events", s.shop, json([event("orders/updated", { id: 12 })]))).toEqual({ outcome: "ignored", recorded: 0 });
  });

  it("lets one run claim an event at a time, backs failures off, kills an event after eight attempts, and reclaims a quiet run's events", async () => {
    const s = await boundShop();
    await call("record_sync_events", s.shop, json([event("orders/updated", { id: 1 }, "a"), event("orders/updated", { id: 2 }, "b")]));
    const claimed = await rowsOf("claim_sync_events", s.key, "run_1", 10, 900);
    expect(claimed.map((e) => [e.topic, e.payload, e.attempts])).toEqual([["orders/updated", { id: 1 }, 1], ["orders/updated", { id: 2 }, 1]]);
    expect(await rowsOf("claim_sync_events", s.key, "run_2", 10, 900)).toEqual([]);

    // Only the run holding the events can end them.
    expect(await call("finish_sync_events", "run_2", [claimed[0].id], json([]), 8)).toMatchObject({ processed: 0 });
    expect(await call("finish_sync_events", "run_1", [claimed[0].id], json([{ id: claimed[1].id, error: "throttled" }]), 8)).toEqual({ processed: 1, failed: 1, dead: 0 });
    expect((await inbox(s)).map((e) => [e.webhook_id, e.status, e.payload, e.last_error])).toEqual([
      ["a", "processed", null, null], ["b", "failed", { id: 2 }, "throttled"],
    ]);
    // Backed off: not due until next_attempt_at.
    expect(await rowsOf("claim_sync_events", s.key, "run_3", 10, 900)).toEqual([]);
    await q("update public.webhook_events set next_attempt_at = now() - interval '1 second' where shop_key = $1 and webhook_id = 'b'", [s.key]);
    expect((await rowsOf("sync_shops_due", 1000)).find((r) => r.shop_key === s.key)).toMatchObject({ due: 1, dead: 0 });
    const again = await rowsOf("claim_sync_events", s.key, "run_3", 10, 900);
    expect(again.map((e) => e.attempts)).toEqual([2]);

    // A run that went quiet: its events go to the next run.
    await q("update public.webhook_events set claimed_at = now() - interval '20 minutes' where shop_key = $1 and webhook_id = 'b'", [s.key]);
    const taken = await rowsOf("claim_sync_events", s.key, "run_4", 10, 900);
    expect(taken.map((e) => e.attempts)).toEqual([3]);
    await q("update public.webhook_events set attempts = 8 where shop_key = $1 and webhook_id = 'b'", [s.key]);
    expect(await call("finish_sync_events", "run_4", [], json([{ id: taken[0].id, error: "still failing" }]), 8)).toEqual({ processed: 0, failed: 0, dead: 1 });
    expect((await inbox(s))[1]).toMatchObject({ status: "dead", payload: { id: 2 } });
    expect((await rowsOf("sync_shops_due", 1000)).some((r) => r.shop_key === s.key)).toBe(false);
  });
});

describe("sync writes (task 10)", () => {
  it("deletes what Shopify no longer has, with what hangs off it, and marks the order's month for its summaries", async () => {
    const s = await boundShop();
    const at = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await call("ingest_catalog", s.key,
      json([{ shopify_id: 7, title: "Lamp", status: "active" }]),
      json([{ shopify_id: 70, product_shopify_id: 7, price: 10, inventory_item_id: 700 }]),
      json([{ owner_type: "product", owner_shopify_id: 7, namespace: "specs", key: "watts", type: "number_integer", value_excerpt: "40" }]));
    await call("ingest_inventory", s.key, json([{ shopify_id: 3, name: "Warehouse", country_code: "GB" }]), json([{ inventory_item_id: 700, location_shopify_id: 3, available: 4 }]));
    await call("ingest_orders", s.key,
      json([{ shopify_id: 11, shopify_created_at: at, processed_at: at, currency: "GBP", total_price: 10, shopify_updated_at: at }]),
      json([{ shopify_id: 111, order_shopify_id: 11, product_shopify_id: 7, quantity: 1, unit_price: 10 }]),
      json([{ shopify_id: 112, order_shopify_id: 11, shopify_created_at: at, total_refunded: 1, currency: "GBP" }]));
    await call("ingest_returns", s.key, json([{ shopify_id: 113, order_shopify_id: 11, status: "closed", total_quantity: 1 }]),
      json([{ shopify_id: 114, return_shopify_id: 113, line_item_shopify_id: 111, quantity: 1 }]));
    await call("ingest_customers", s.key, json([{ shopify_id: 501, orders_count: 1 }]));
    await q("delete from public.summary_dirty_months where shop_key = $1", [s.key]);

    expect(await call("delete_synced_records", s.key, "order", "{11}")).toEqual({ deleted: 1 });
    expect(await call("delete_synced_records", s.key, "product", "{7}")).toEqual({ deleted: 1 });
    expect(await call("delete_synced_records", s.key, "customer", "{501}")).toEqual({ deleted: 1 });
    const counts = await one(`select ${["orders", "order_line_items", "refunds", "returns", "return_line_items", "products", "product_variants", "metafields", "inventory_levels", "customers"]
      .map((t) => `(select count(*) from public.${t} where shop_key = $1)::int as ${t}`).join(", ")}`, [s.key]);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(await q("select month::text from public.summary_dirty_months where shop_key = $1", [s.key])).toEqual([{ month: `${at.slice(0, 7)}-01` }]);
    await expect(call("delete_synced_records", s.key, "variant", "{1}")).rejects.toThrow(/record_kind_invalid/);
  });

  it("moves a watermark only forward and leaves the import's checkpoint time alone", async () => {
    const s = await boundShop();
    expect(await call("save_sync_watermark", s.key, "orders", "2026-11-21T00:00:00Z")).toEqual({ watermark: "2026-11-21T00:00:00+00:00" });
    expect(await one("select updated_at::text from public.sync_checkpoints where shop_key = $1 and domain = 'orders'", [s.key])).toEqual({ updated_at: "-infinity" });
    await call("save_sync_checkpoint", s.key, "catalog", null, 42, 100, null);
    const before = await one("select updated_at from public.sync_checkpoints where shop_key = $1 and domain = 'catalog'", [s.key]);
    await call("save_sync_watermark", s.key, "catalog", "2026-11-22T00:00:00Z");
    expect(await one("select updated_at, bulk_operation_id::int as op, committed_line::int as line from public.sync_checkpoints where shop_key = $1 and domain = 'catalog'", [s.key]))
      .toEqual({ updated_at: before.updated_at, op: 42, line: 100 });
    expect(await call("save_sync_watermark", s.key, "orders", "2026-11-01T00:00:00Z")).toEqual({ watermark: "2026-11-21T00:00:00+00:00" });
  });

  it("lets service_role run the sync functions and nothing more", async () => {
    for (const fn of [
      "record_sync_events(text, jsonb)", "claim_sync_events(integer, text, integer, integer)", "finish_sync_events(text, uuid[], jsonb, integer)",
      "sync_shops_due(integer)", "delete_synced_records(integer, text, bigint[])", "save_sync_watermark(integer, text, timestamptz)",
    ]) {
      expect(await one(
        `select has_function_privilege('service_role', $1, 'execute') as service,
                has_function_privilege('anon', $1, 'execute') or has_function_privilege('authenticated', $1, 'execute') as public_exec`, [`public.${fn}`]), fn)
        .toEqual({ service: true, public_exec: false });
    }
  });
});
