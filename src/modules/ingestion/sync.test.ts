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
function harness(shopify: { orders?: Record<number, Raw | Error>; products?: Record<number, Raw>; customers?: Record<number, Raw>; updated?: Record<string, Array<{ id: string; updatedAt: string }>>; refundLines?: Record<number, Raw[]>; inventory?: Record<number, Raw> }) {
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
    if (query.includes("RefundLinesById")) {
      calls.push(`refund ${id}`);
      const lines = shopify.refundLines?.[Number(id.split("/").pop())];
      return { node: lines ? { refundLineItems: conn(lines) } : null };
    }
    if (query.includes("ProductById")) return { node: shopify.products?.[Number(id.split("/").pop())] ? structuredClone(shopify.products[Number(id.split("/").pop())]) : null };
    if (query.includes("VariantMetafields")) {
      calls.push(`variant metafields ${id} after ${String(variables.after)}`);
      return { node: { id, metafields: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: "gid://shopify/Metafield/99", namespace: "specs", key: "late", type: "single_line_text_field", value: "page 2" } }] } } };
    }
    if (query.includes("InventoryItemById")) return { node: shopify.inventory?.[Number(id.split("/").pop())] ?? null };
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
    historyWindowStart: vi.fn(async () => Date.parse("2024-11-01T00:00:00Z")),
    writeHistoryArrivals: vi.fn(async (): Promise<Raw> => ({ history_orders: 1, orders_applied: 0, refunds_applied: 1 })),
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

  it("reads a product's variant metafields beyond the first page, writes them under the variant, then resolves new references (Phase 3, task 2)", async () => {
    const variant = {
      id: "gid://shopify/ProductVariant/71", price: "10",
      metafields: { pageInfo: { hasNextPage: true, endCursor: "c1" }, edges: [{ node: { id: "gid://shopify/Metafield/98", namespace: "specs", key: "length", type: "dimension", value: "{}" } }] },
    };
    const t = harness({ products: { 7: { id: "gid://shopify/Product/7", title: "Board", status: "ACTIVE", variants: conn([variant]), metafields: conn([]) } } });
    const references = vi.fn(async () => ({}));
    t.push("e1", "products/update", { id: 7 });
    await processShopEvents("s.myshopify.com", "run_1", { ...t.deps, references });
    expect(t.calls).toEqual(["variant metafields gid://shopify/ProductVariant/71 after c1"]);
    const batch = (t.writes.writeCatalog.mock.calls[0] as unknown[])[1] as { metafields: Array<{ owner_type: string; owner_shopify_id: number; key: string }> };
    expect(batch.metafields.map((m) => [m.owner_type, m.owner_shopify_id, m.key])).toEqual([["variant", 71, "length"], ["variant", 71, "late"]]);
    expect(references).toHaveBeenCalledWith(expect.any(Function), 2);

    // A failure to read references leaves the product's events processed: the daily reconcile repairs references.
    const u = harness({ products: { 7: { id: "gid://shopify/Product/7", title: "Board", status: "ACTIVE", variants: conn([]), metafields: conn([]) } } });
    u.push("e1", "products/update", { id: 7 });
    await processShopEvents("s.myshopify.com", "run_1", { ...u.deps, references: async () => { throw new Error("throttled"); } });
    expect(u.inbox[0].status).toBe("processed");
  });

  it("writes an inventory item's levels as its complete list, with any location named in full (Phase 3, task 3)", async () => {
    const level = (location: Raw, available: number) => ({ id: `gid://shopify/InventoryLevel/${available}`, isActive: true, updatedAt: "2026-11-22T10:00:00Z", location,
      quantities: [{ name: "available", quantity: available }, { name: "committed", quantity: 1 }, { name: "on_hand", quantity: available + 1 }] });
    const t = harness({ inventory: { 12: { id: "gid://shopify/InventoryItem/12", inventoryLevels: conn([
      level({ id: "gid://shopify/Location/50", name: "Warehouse", isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: false }, 4),
      level({ id: "gid://shopify/Location/53", name: "3PL", isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: true,
        fulfillmentService: { handle: "shipbob", serviceName: "ShipBob", type: "THIRD_PARTY", inventoryManagement: true } }, 7),
    ]) } } });
    t.push("e1", "inventory_levels/update", { inventory_item_id: 12, location_id: 50, updated_at: "2026-11-22T10:00:00Z" });
    t.push("e2", "inventory_levels/update", { inventory_item_id: 12, location_id: 53, updated_at: "2026-11-22T10:00:00Z" });
    await processShopEvents("s.myshopify.com", "run_1", t.deps);
    expect(t.writes.writeInventory).toHaveBeenCalledTimes(1);
    const batch = (t.writes.writeInventory.mock.calls[0] as unknown[])[1] as { locations: Array<{ shopify_id: number; fulfillment_service_type: string | null }>; levels: Array<{ location_shopify_id: number; committed: number }>; completeItems: number[] };
    expect(batch.completeItems).toEqual([12]);
    expect(batch.levels.map((l) => [l.location_shopify_id, l.committed])).toEqual([[50, 1], [53, 1]]);
    expect(batch.locations.map((l) => [l.shopify_id, l.fulfillment_service_type])).toEqual([[50, null], [53, "third_party"]]);
    expect(t.inbox.every((e) => e.status === "processed")).toBe(true);
  });

  it("reads new refunds' line items after writing orders, and keeps the orders when that fails (Phase 3, task 4)", async () => {
    const t = harness({ orders: { 11: orderNode(11, "30.00", "2026-11-22T10:05:00Z") } });
    const refundLines = vi.fn(async () => ({}));
    t.push("e1", "refunds/create", { order_id: 11, created_at: "2026-11-22T10:05:00Z" });
    await processShopEvents("s.myshopify.com", "run_1", { ...t.deps, refundLines });
    expect(refundLines).toHaveBeenCalledWith(expect.any(Function), 2);
    expect(t.writes.writeOrders).toHaveBeenCalled();

    const u = harness({ orders: { 11: orderNode(11, "30.00", "2026-11-22T10:05:00Z") } });
    u.push("e1", "orders/updated", { id: 11 });
    await processShopEvents("s.myshopify.com", "run_1", { ...u.deps, refundLines: async () => { throw new Error("throttled"); } });
    expect(u.inbox[0].status).toBe("processed");
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

describe("history arrivals (0042)", () => {
  const refund = { id: "gid://shopify/Refund/91", createdAt: "2026-11-22T09:30:00Z", processedAt: "2024-06-01T00:00:00Z", totalRefundedSet: { shopMoney: { amount: "5.00", currencyCode: "GBP" } } };
  const oldOrder = (id: number) => ({ ...orderNode(id, "20.00", "2026-11-22T10:00:00Z"), processedAt: "2024-05-20T10:00:00Z", createdAt: "2026-11-22T09:00:00Z", refunds: [refund] });
  const unit = { quantity: 1, lineItem: { product: { id: "gid://shopify/Product/7" } } };
  const setup = () => {
    const t = harness({ orders: { 31: oldOrder(31), 32: orderNode(32, "9.00", "2026-11-22T10:00:00Z") }, refundLines: { 91: [unit] } });
    t.writes.writeOrders.mockResolvedValueOnce({ beyond_window: 1 } as never);
    t.push("e1", "refunds/create", { id: 91, order_id: 31, created_at: "2026-11-22T09:30:00Z" });
    t.push("e2", "orders/updated", { id: 32, updated_at: "2026-11-22T10:00:00Z" });
    return t;
  };

  it("passes orders from before the window to the history arrivals, with their refunds' line items", async () => {
    const t = setup();
    await processShopEvents("s.myshopify.com", "run_1", t.deps);
    expect(t.writes.historyWindowStart).toHaveBeenCalledWith(2);
    expect(t.calls).toContain("refund gid://shopify/Refund/91");
    const batch = (t.writes.writeHistoryArrivals.mock.calls[0] as unknown[])[2] as { orders: Array<{ shopify_id: number }>; refunds: unknown[]; refundLines: unknown[] };
    expect(batch.orders.map((o) => o.shopify_id)).toEqual([31]);
    expect(batch.refunds).toEqual([expect.objectContaining({ shopify_id: 91, processed_at: "2024-06-01T00:00:00Z" })]);
    expect(batch.refundLines).toEqual([{ refund_shopify_id: 91, product_shopify_id: 7, quantity: 1 }]);
    expect(t.inbox.every((e) => e.status === "processed")).toBe(true);
  });

  it("tries a history arrival again while an import is in progress, and finishes the other orders", async () => {
    const t = setup();
    t.writes.writeHistoryArrivals.mockResolvedValueOnce({ history_orders: 1, deferred: true });
    await processShopEvents("s.myshopify.com", "run_1", t.deps);
    expect(t.inbox.map((e) => [e.id, e.status])).toEqual([["e1", "failed"], ["e2", "processed"]]);
    expect((t.repo.finishSyncEvents.mock.calls[0] as unknown[])[2]).toEqual([{ id: "e1", error: "history_import_active" }]);
  });

  it("looks for history only when the write reports orders beyond the window", async () => {
    const t = harness({ orders: { 32: orderNode(32, "9.00", "2026-11-22T10:00:00Z") } });
    t.push("e1", "orders/updated", { id: 32 });
    await processShopEvents("s.myshopify.com", "run_1", t.deps);
    expect(t.writes.historyWindowStart).not.toHaveBeenCalled();
    expect(t.writes.writeHistoryArrivals).not.toHaveBeenCalled();
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

  it("replays changes since a time under its own event IDs, for the requested domains only", async () => {
    const t = reconcileHarness({ orders: [{ id: "gid://shopify/Order/21", updatedAt: "2026-11-21T09:00:00Z" }] }, { orders: "2026-11-22T00:00:00Z" });
    // The daily reconcile saw this change already.
    t.push("reconcile:orders/updated:21:2026-11-21T09:00:00Z", "orders/updated", { id: 21 });
    t.inbox[0].status = "processed";
    const report = await reconcileShopUpdates("s.myshopify.com", t.reconcileDeps, { replay: { since: "2026-11-21T00:00:00Z", tag: "history-0042", domains: ["orders"] } });
    expect(report).toMatchObject({ orders: { found: 1, recorded: 1 }, catalog: { skipped: "not_requested" }, customers: { skipped: "not_requested" } });
    // From the replay's time, without the overlap, and recorded under the replay's own ID.
    expect(String((t.gql.mock.calls.find((call) => String(call[0]).includes("orders(first"))![1] as Raw).query)).toBe("updated_at:>='2026-11-21T00:00:00.000Z'");
    expect(t.inbox.map((e) => [e.id, e.status])).toContainEqual(["reconcile:history-0042:orders/updated:21:2026-11-21T09:00:00Z", "received"]);
    await expect(reconcileShopUpdates("s.myshopify.com", t.reconcileDeps, { replay: { since: "2026-11-21T00:00:00Z", tag: "Not a tag" } })).rejects.toThrow("replay");
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
