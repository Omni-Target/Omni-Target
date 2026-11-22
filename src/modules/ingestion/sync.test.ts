import { describe, expect, it, vi } from "vitest";
import { processShopEvents, reconcileShopUpdates, type ReconcileDeps, type SyncDeps } from "./sync";

vi.mock("@/platform/supabase", () => ({ supabaseAdmin: {} }));

type Raw = Record<string, unknown>;
const conn = (nodes: Raw[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, edges: nodes.map((node) => ({ node })) });
const orderNode = (id: number, total: string, updatedAt: string) => ({
  id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: "2026-11-01T00:00:00Z", processedAt: "2026-11-01T00:00:00Z", updatedAt,
  test: false, currencyCode: "GBP", totalPriceSet: { shopMoney: { amount: total } }, customer: { id: "gid://shopify/Customer/501" }, refunds: [],
  lineItems: conn([{ id: `gid://shopify/LineItem/${id}1`, quantity: 1, currentQuantity: 1, product: { id: "gid://shopify/Product/7" }, originalUnitPriceSet: { shopMoney: { amount: total } } }]),
});

/** A fake Shopify holding current state, and a fake inbox. */
function harness(shopify: { orders?: Record<number, Raw | Error>; products?: Record<number, Raw>; customers?: Record<number, Raw>; updated?: Record<string, Array<{ id: string; updatedAt: string }>> }) {
  const inbox: Array<{ id: string; topic: string; payload: Raw; status: string }> = [];
  const calls: string[] = [];
  const gql = vi.fn(async (query: string, variables: Raw = {}) => {
    const id = String(variables.id ?? "");
    if (query.includes("OrderById")) {
      calls.push(`order ${id}`);
      const found = shopify.orders?.[Number(id.split("/").pop())];
      if (found instanceof Error) throw found;
      return { node: found ? structuredClone(found) : null };
    }
    if (query.includes("ProductById")) return { node: shopify.products?.[Number(id.split("/").pop())] ?? null };
    if (query.includes("CustomersById")) return { nodes: (variables.ids as string[]).map((gid) => shopify.customers?.[Number(gid.split("/").pop())] ?? null) };
    if (query.includes("UpdatedSince")) {
      const connection = ["orders", "products", "customers"].find((name) => query.includes(`${name}(first`))!;
      return { [connection]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: shopify.updated?.[connection] ?? [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
  const writes = {
    writeOrders: vi.fn(async () => ({})), writeCatalog: vi.fn(async () => ({})), writeCustomers: vi.fn(async () => ({})),
    writeInventory: vi.fn(async () => ({})), writeReturns: vi.fn(async () => ({})),
  };
  const repo = {
    claimSyncEvents: vi.fn(async () => {
      const due = inbox.filter((e) => e.status === "received");
      for (const e of due) e.status = "processing";
      return due.map((e) => ({ id: e.id, topic: e.topic, payload: e.payload, triggered_at: null, attempts: 1 }));
    }),
    finishSyncEvents: vi.fn(async (_run: string, processed: string[], failed: Array<{ id: string }>) => {
      for (const e of inbox) if (processed.includes(e.id)) e.status = "processed";
      for (const e of inbox) if (failed.some((f) => f.id === e.id)) e.status = "failed";
      return { processed: processed.length, failed: failed.length, dead: 0 };
    }),
    deleteSyncedRecords: vi.fn(async (_shop: number, _kind: string, ids: number[]) => ({ deleted: ids.length })),
  };
  const shop = vi.fn(async () => ({ shopKey: 2, shopifyShopId: 61555736640, shopId: "shop-uuid" }));
  const deps: SyncDeps = { shop, gql: async () => gql as never, repo: repo as never, writes: writes as never };
  const push = (id: string, topic: string, payload: Raw) => inbox.push({ id, topic, payload, status: "received" });
  return { inbox, calls, gql, writes, repo, deps, push, shop };
}

describe("incremental sync worker (task 10)", () => {
  it("fetches each changed resource once, writes Shopify's current state, and deletes what Shopify no longer has", async () => {
    const t = harness({ orders: { 11: orderNode(11, "30.00", "2026-11-22T10:05:00Z") }, customers: { 501: { id: "gid://shopify/Customer/501", numberOfOrders: "3", updatedAt: "2026-11-22T10:00:00Z" } } });
    // Delivered out of order: the newer update first, then the creation.
    t.push("e1", "orders/updated", { id: 11, updated_at: "2026-11-22T10:05:00Z" });
    t.push("e2", "orders/create", { id: 11, updated_at: "2026-11-22T10:00:00Z" });
    t.push("e3", "orders/delete", { id: 12 });
    t.push("e4", "customers/update", { id: 501, updated_at: "2026-11-22T10:00:00Z" });
    t.push("e5", "orders/updated", {});
    const report = await processShopEvents("s.myshopify.com", "run_1", t.deps);

    expect(t.calls).toEqual(["order gid://shopify/Order/11", "order gid://shopify/Order/12"]);
    const written = (t.writes.writeOrders.mock.calls[0] as unknown[])[2] as { orders: Array<{ shopify_id: number; total_price: string }>; lineItems: unknown[] };
    expect(written.orders).toEqual([expect.objectContaining({ shopify_id: 11, total_price: "30.00" })]);
    expect(written.lineItems).toHaveLength(1);
    expect(t.repo.deleteSyncedRecords).toHaveBeenCalledWith(2, "order", [12]);
    expect(t.writes.writeCustomers).toHaveBeenCalledWith(2, 61555736640, [expect.objectContaining({ shopify_id: 501 })]);
    expect(t.inbox.every((e) => e.status === "processed")).toBe(true);
    expect(report).toMatchObject({ outcome: "drained", events: 5, resources: { order: 2, customer: 1 }, deleted: 1, processed: 5, failed: 0 });
  });

  it("gives back only the events of a resource whose fetch failed, and every event of a kind whose write failed", async () => {
    const t = harness({ orders: { 11: new Error("Shopify GraphQL throttled"), 13: orderNode(13, "5.00", "2026-11-22T10:00:00Z") }, products: { 7: { id: "gid://shopify/Product/7", title: "Lamp", status: "ACTIVE", variants: conn([]), metafields: conn([]) } } });
    t.push("e1", "orders/updated", { id: 11 });
    t.push("e2", "orders/updated", { id: 13 });
    t.push("e3", "products/update", { id: 7 });
    const report = await processShopEvents("s.myshopify.com", "run_1", t.deps);
    expect(t.inbox.map((e) => [e.id, e.status])).toEqual([["e1", "failed"], ["e2", "processed"], ["e3", "processed"]]);
    expect(report).toMatchObject({ processed: 2, failed: 1 });

    const u = harness({ orders: { 11: orderNode(11, "1.00", "2026-11-22T10:00:00Z") } });
    u.writes.writeOrders.mockRejectedValueOnce(new Error("statement timeout"));
    u.push("e1", "orders/updated", { id: 11 });
    u.push("e2", "refunds/create", { order_id: 11 });
    await processShopEvents("s.myshopify.com", "run_1", u.deps);
    expect(u.inbox.map((e) => e.status)).toEqual(["failed", "failed"]);
  });

  it("leaves the inbox alone without access, and stops at its time budget", async () => {
    const t = harness({});
    t.push("e1", "orders/updated", { id: 11 });
    expect(await processShopEvents("s.myshopify.com", "run_1", { ...t.deps, gql: async () => null })).toMatchObject({ outcome: "no_access" });
    expect(t.repo.claimSyncEvents).not.toHaveBeenCalled();
    let clock = 0;
    expect(await processShopEvents("s.myshopify.com", "run_1", { ...t.deps, now: () => (clock += 1_000) }, { budgetMs: 500 })).toMatchObject({ outcome: "budget", events: 0 });
    expect(await processShopEvents("s.myshopify.com", "run_1", { ...t.deps, shop: async () => null })).toMatchObject({ outcome: "not_ingestible" });
  });
});

describe("daily reconcile (task 10)", () => {
  function reconcileHarness(updated: Record<string, Array<{ id: string; updatedAt: string }>>, watermarks: Record<string, string | null> = {}) {
    const t = harness({ updated, orders: { 21: orderNode(21, "12.00", "2026-11-21T09:00:00Z") } });
    const saved: Record<string, string> = {};
    const repo = {
      loadSyncWatermark: vi.fn(async (_shop: number, domain: string) => watermarks[domain] ?? null),
      lastImportStart: vi.fn(async () => "2026-11-20T00:00:00Z"),
      recordSyncEvents: vi.fn(async (_domain: string, events: Array<{ webhook_id: string; topic: string; payload: Raw }>) => {
        let recorded = 0;
        for (const event of events) {
          if (t.inbox.some((e) => e.id === event.webhook_id)) continue;
          t.push(event.webhook_id, event.topic, event.payload);
          recorded += 1;
        }
        return { outcome: "recorded" as const, recorded };
      }),
      saveSyncWatermark: vi.fn(async (_shop: number, domain: string, watermark: string) => {
        saved[domain] = watermark;
        return { watermark };
      }),
    };
    const deps: ReconcileDeps = { shop: t.shop, gql: async () => t.gql as never, repo: repo as never };
    return { ...t, saved, reconcileRepo: repo, reconcileDeps: deps };
  }

  it("repairs a missed webhook: the change is found by its updated time and goes through the worker", async () => {
    const t = reconcileHarness({ orders: [{ id: "gid://shopify/Order/21", updatedAt: "2026-11-21T09:00:00Z" }] });
    const report = await reconcileShopUpdates("s.myshopify.com", t.reconcileDeps);
    expect(report).toMatchObject({ orders: { found: 1, recorded: 1, watermark: "2026-11-21T09:00:00Z" }, catalog: { found: 0 }, customers: { found: 0 } });
    // First run: from the last import's start, less the overlap.
    expect(String((t.gql.mock.calls.find((call) => String(call[0]).includes("orders(first"))![1] as Raw).query)).toBe("updated_at:>='2026-11-19T23:00:00.000Z'");
    expect(t.saved).toEqual({ orders: "2026-11-21T09:00:00Z", catalog: "2026-11-20T00:00:00Z", customers: "2026-11-20T00:00:00Z" });

    await processShopEvents("s.myshopify.com", "run_1", t.deps);
    expect(t.writes.writeOrders).toHaveBeenCalledWith(2, 61555736640, expect.objectContaining({ orders: [expect.objectContaining({ shopify_id: 21 })] }));
    // Seen again next day: recorded once only.
    expect((await reconcileShopUpdates("s.myshopify.com", t.reconcileDeps) as { orders: { recorded: number } }).orders.recorded).toBe(0);
  });

  it("continues from where a truncated run stopped, and skips a domain never imported", async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ id: `gid://shopify/Product/${i + 1}`, updatedAt: `2026-11-21T0${i}:00:00Z` }));
    const t = reconcileHarness({ products: many }, { catalog: "2026-11-21T00:00:00Z" });
    t.reconcileRepo.lastImportStart.mockResolvedValueOnce("2026-11-20T00:00:00Z").mockResolvedValueOnce(null as never);
    const report = await reconcileShopUpdates("s.myshopify.com", t.reconcileDeps, { maxPerDomain: 2 }) as Record<string, { found: number; skipped?: string; watermark: string | null }>;
    expect(report.catalog).toMatchObject({ found: 3, watermark: "2026-11-21T02:00:00Z" });
    expect(report.customers).toMatchObject({ skipped: "not_imported" });
  });
});
