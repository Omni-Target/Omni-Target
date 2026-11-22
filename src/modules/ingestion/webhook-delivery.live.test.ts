/**
 * Live check of real webhook delivery (Phase 2, task 10): Shopify to a
 * deployed staging app, then the inbox, then a running Trigger.dev worker
 * (`pnpm dev:trigger`). On staging only.
 *
 * Ensures the shop's sync subscriptions at LIVE_WEBHOOK_BASE (an HTTPS base
 * URL, the same value SHOPIFY_WEBHOOK_BASE_URL takes). LIVE_RETIRE_BASE, when
 * set, names an endpoint being replaced: its sync subscriptions are deleted.
 * Then waits up to LIVE_WAIT_MS for deliveries received since LIVE_SINCE
 * (default: now) and for the worker to settle them. The app's scopes are
 * read-only, so the deliveries come from changes made in the shop's admin.
 * For each domain a delivery touched, the shop's most recently updated record
 * must be in the mirror as Shopify has it. Writes its report to LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLED = new Set(["processed", "ignored", "dead"]);
const QUIET_MS = 30_000;

type Node = { id: string; topic: string; uri: string; includeFields: string[] | null };
const LIST_ALL = `{ webhookSubscriptions(first: 100) { nodes { id topic uri includeFields } } }`;
const DELETE = `mutation RetireSyncSubscription($id: ID!) {
  webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } }
}`;
const NEWEST = {
  order: `{ orders(first: 1, sortKey: UPDATED_AT, reverse: true) { nodes { id updatedAt processedAt } } }`,
  product: `{ products(first: 1, sortKey: UPDATED_AT, reverse: true) { nodes { id updatedAt } } }`,
  customer: `{ customers(first: 1, sortKey: UPDATED_AT, reverse: true) { nodes { id updatedAt } } }`,
} as const;
const TABLE = { order: "orders", product: "products", customer: "customers" } as const;

describe("live webhook delivery", () => {
  it("delivers real Shopify webhooks to staging and the worker settles them", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { syncWebhookEndpoint, ensureSyncSubscriptions, SYNC_SUBSCRIPTIONS } = await import("./subscriptions");
    const endpoint = syncWebhookEndpoint({ SHOPIFY_WEBHOOK_BASE_URL: process.env.LIVE_WEBHOOK_BASE });
    if (!endpoint) throw new Error("LIVE_WEBHOOK_BASE must be an HTTPS base URL");
    const retire = process.env.LIVE_RETIRE_BASE ? syncWebhookEndpoint({ SHOPIFY_WEBHOOK_BASE_URL: process.env.LIVE_RETIRE_BASE }) : null;
    if (process.env.LIVE_RETIRE_BASE && (!retire || retire === endpoint)) throw new Error("LIVE_RETIRE_BASE must be another HTTPS base URL");
    const since = new Date(process.env.LIVE_SINCE ?? Date.now());
    if (Number.isNaN(since.getTime())) throw new Error("LIVE_SINCE must be a date");
    const waitMs = Number(process.env.LIVE_WAIT_MS ?? 600_000);

    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { SYNC_TOPICS } = await import("./sync-events");
    const { parseGid } = await import("./gid");
    const repo = await import("./sync-repository");
    const shop = await repo.syncShop(domain);
    if (!shop) throw new Error("shop not ingestible");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const gql: import("./bulk").Gql = (query, variables) => shopifyGraphql(domain, access.accessToken, query, variables);

    // Subscriptions: what the shop has, the ones this endpoint needs, and any being retired.
    const byUri = (nodes: Node[]) => Object.fromEntries([...new Set(nodes.map((n) => n.uri))].map((uri) => [uri, nodes.filter((n) => n.uri === uri).length]));
    const before = (await gql<{ webhookSubscriptions: { nodes: Node[] } }>(LIST_ALL)).webhookSubscriptions.nodes;
    const ensured = await ensureSyncSubscriptions(gql, endpoint);
    const retired: string[] = [];
    const retireFailed: Array<{ topic: string; error: string }> = [];
    if (retire) {
      const topics = new Set(SYNC_SUBSCRIPTIONS.map((s) => s.topic));
      for (const node of before.filter((n) => n.uri === retire && topics.has(n.topic))) {
        const result = (await gql<{ webhookSubscriptionDelete: { deletedWebhookSubscriptionId: string | null; userErrors: Array<{ message: string }> } }>(DELETE, { id: node.id })).webhookSubscriptionDelete;
        if (result.userErrors.length || !result.deletedWebhookSubscriptionId) retireFailed.push({ topic: node.topic, error: result.userErrors.map((e) => e.message).join("; ") || "not deleted" });
        else retired.push(node.topic);
      }
    }
    const after = (await gql<{ webhookSubscriptions: { nodes: Node[] } }>(LIST_ALL)).webhookSubscriptions.nodes;

    // Real deliveries since `since` (the reconcile's own events are named reconcile:…), until the worker settles them.
    type Row = { webhook_id: string; event_id: string | null; topic: string; triggered_at: string | null; received_at: string; status: string; attempts: number; last_error: string | null; processed_at: string | null };
    const PAGE = 1000; // PostgREST returns at most 1,000 rows per request
    const deliveries = async (): Promise<Row[]> => {
      const all: Row[] = [];
      for (let from = 0; from < 20 * PAGE; from += PAGE) {
        const { data, error } = await supabaseAdmin.from("webhook_events")
          .select("webhook_id, event_id, topic, triggered_at, received_at, status, attempts, last_error, processed_at")
          .eq("shop_domain", domain).gte("received_at", since.toISOString()).not("webhook_id", "like", "reconcile:%")
          .in("topic", [...SYNC_TOPICS]).order("received_at").order("webhook_id").range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        all.push(...((data ?? []) as Row[]));
        if ((data ?? []).length < PAGE) break;
      }
      return all;
    };
    const deadline = Date.now() + waitMs;
    let rows: Row[] = [];
    let lastCount = -1;
    let lastChange = Date.now();
    for (;;) {
      rows = await deliveries();
      if (rows.length !== lastCount) { lastCount = rows.length; lastChange = Date.now(); }
      const settled = rows.length > 0 && rows.every((r) => SETTLED.has(r.status));
      if (settled && Date.now() - lastChange >= QUIET_MS) break;
      if (Date.now() > deadline) break;
      if (rows.length === 0) console.log(`waiting for a change in ${domain} (deliveries since ${since.toISOString()})`);
      await sleep(rows.length ? 5_000 : 30_000);
    }

    // The mirror holds each touched domain's most recently updated record as Shopify has it.
    const touched = new Set(rows.map((r) => r.topic.startsWith("refunds/") ? "order" : r.topic.split("/")[0].replace(/s$/, "")));
    const { data: windowStartRaw } = await supabaseAdmin.rpc("shop_window_start", { p_shop_key: shop.shopKey });
    const windowStart = Date.parse(String(windowStartRaw));
    const mirror: Array<{ kind: string; id: number; shopify: string; mirrored: string | null; note?: string }> = [];
    for (const kind of ["order", "product", "customer"] as const) {
      if (!touched.has(kind)) continue;
      const node = (await gql<Record<string, { nodes: Array<{ id: string; updatedAt: string; processedAt?: string }> }>>(NEWEST[kind]))[`${kind}s`].nodes[0];
      if (!node) continue;
      const id = parseGid(node.id)!;
      if (kind === "order" && node.processedAt && Date.parse(node.processedAt) < windowStart) {
        mirror.push({ kind, id, shopify: node.updatedAt, mirrored: null, note: "before the window: summarised, not held as detail" });
        continue;
      }
      const { data } = await supabaseAdmin.from(TABLE[kind]).select("shopify_updated_at").eq("shop_key", shop.shopKey).eq("shopify_id", id).maybeSingle();
      mirror.push({ kind, id, shopify: node.updatedAt, mirrored: (data?.shopify_updated_at as string | null) ?? null });
    }

    const seconds = (from: string | null, to: string | null) => from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10 : null;
    const report = {
      endpoint, since: since.toISOString(), retire,
      subscriptions: { before: byUri(before), after: byUri(after), ensured, retired, retireFailed },
      deliveries: rows.length,
      byTopic: Object.fromEntries([...new Set(rows.map((r) => r.topic))].map((t) => [t, rows.filter((r) => r.topic === t).length])),
      byStatus: Object.fromEntries([...new Set(rows.map((r) => r.status))].map((s) => [s, rows.filter((r) => r.status === s).length])),
      withShopifyIds: rows.filter((r) => r.event_id && !r.webhook_id.startsWith("body:")).length,
      deliverySeconds: rows.map((r) => seconds(r.triggered_at, r.received_at)),
      processingSeconds: rows.map((r) => seconds(r.received_at, r.processed_at)),
      maxAttempts: Math.max(0, ...rows.map((r) => r.attempts)),
      errors: rows.filter((r) => r.last_error).map((r) => ({ topic: r.topic, status: r.status, error: r.last_error })).slice(0, 10),
      mirror,
    };
    console.log("delivery", JSON.stringify(report).slice(0, 4000));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(report, null, 1));

    expect(ensured.failed).toEqual([]);
    expect(retireFailed).toEqual([]);
    expect(after.filter((n) => n.uri === endpoint).length).toBe(SYNC_SUBSCRIPTIONS.length);
    if (retire) expect(after.filter((n) => n.uri === retire).length).toBe(0);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "processed" || r.status === "ignored")).toBe(true);
    expect(report.withShopifyIds).toBe(rows.length);
    for (const entry of mirror) if (!entry.note) expect(entry.mirrored && Date.parse(entry.mirrored)).toBe(Date.parse(entry.shopify));
  }, 3_600_000);
});
