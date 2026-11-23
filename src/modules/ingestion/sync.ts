import "server-only";
import { createLogger } from "@/platform/logger";
import type { Gql } from "./bulk";
import type { JsonlUnit } from "./jsonl";
import { mapCustomerUnit, mapInventoryLocations, mapInventoryUnit, mapOrderUnit, mapProductUnit, mapRefundLines, mapReturnsUnit, type OrderRow, type RefundLineRow } from "./mappers";
import {
  CUSTOMERS_BY_ID, INVENTORY_ITEM_BY_ID, ORDER_BY_ID, PRODUCT_BY_ID, PRODUCT_METAFIELDS_PAGE, PRODUCT_VARIANTS_PAGE, REFUND_LINES_BY_ID, RETURN_BY_ID,
  VARIANT_METAFIELDS_PAGE,
  searchFilter, updatedSinceQuery,
} from "./queries";
import { chunkUnits, groupResources, unitFromNode, type SyncKind, type SyncResource } from "./sync-events";
import type * as SyncRepository from "./sync-repository";
import type * as Writes from "./writes";

/**
 * Incremental sync (Phase 2, task 10).
 *
 * processShopEvents drains a shop's inbox: it claims events, groups them by
 * resource, fetches each resource's current state from Shopify by ID and
 * writes it through the ingestion functions (which check redaction digests,
 * the retention window and Shopify's updated_at). A resource Shopify no longer
 * has is deleted here. So duplicates are fetched once, out-of-order deliveries
 * converge on Shopify's state, and no customer data travels in the inbox.
 *
 * reconcileShopUpdates lists the orders, products and customers updated since
 * each domain's watermark and records them as events: a missed webhook is
 * repaired by the same path the next day. Deletions are seen only through
 * webhooks; a periodic import covers what both miss.
 *
 * Orders from before the retained window are not held as detail. Those that
 * arrive late (created, or refunded, after their month's summary closed) are
 * passed to apply_history_arrivals (0042) with their refunds' line items, and
 * become adjustments to the history months they belong to.
 */
const log = createLogger({ module: "incremental-sync" });
const WRITE_ROWS = 2_000;
type Raw = Record<string, unknown>;

export interface SyncDeps {
  shop: (shopDomain: string) => ReturnType<typeof SyncRepository.syncShop>;
  gql: (shopDomain: string) => Promise<Gql | null>;
  /** After products are written: reads the metaobjects they newly reference (Phase 3, task 2). */
  references?: (gql: Gql, shopKey: number) => Promise<unknown>;
  /** After orders are written: reads the line items of their new refunds (Phase 3, task 4). */
  refundLines?: (gql: Gql, shopKey: number) => Promise<unknown>;
  repo: Pick<typeof SyncRepository, "claimSyncEvents" | "finishSyncEvents" | "deleteSyncedRecords">;
  writes: Pick<typeof Writes, "writeOrders" | "writeCatalog" | "writeCustomers" | "writeInventory" | "writeReturns" | "writeHistoryArrivals" | "historyWindowStart">;
  now?: () => number;
}

const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;
const edgesOf = (node: Raw, field: string) => ((node[field] as Raw | undefined)?.edges as unknown[] | undefined) ?? [];
const pageOf = (node: Raw, field: string) => ((node[field] as Raw | undefined)?.pageInfo as { hasNextPage?: boolean; endCursor?: string | null } | undefined) ?? {};

/** Follows a connection's later pages into the node (at most 50 more pages). */
async function allPages(gql: Gql, node: Raw, field: string, query: string, id: string): Promise<void> {
  let info = pageOf(node, field);
  for (let page = 0; info.hasNextPage && info.endCursor && page < 50; page++) {
    const next = (await gql<{ node: Raw | null }>(query, { id, after: info.endCursor })).node;
    if (!next) break;
    (edgesOf(node, field) as unknown[]).push(...edgesOf(next, field));
    info = pageOf(next, field);
  }
}

async function fetchOne(gql: Gql, kind: Exclude<SyncKind, "customer">, id: number): Promise<JsonlUnit | null> {
  if (kind === "order") {
    const node = (await gql<{ node: Raw | null }>(ORDER_BY_ID, { id: gid("Order", id) })).node;
    if (!node) return null;
    await allPages(gql, node, "lineItems", ORDER_BY_ID, gid("Order", id));
    return unitFromNode(node);
  }
  if (kind === "product") {
    const node = (await gql<{ node: Raw | null }>(PRODUCT_BY_ID, { id: gid("Product", id) })).node;
    if (!node) return null;
    await allPages(gql, node, "variants", PRODUCT_VARIANTS_PAGE, gid("Product", id));
    await allPages(gql, node, "metafields", PRODUCT_METAFIELDS_PAGE, gid("Product", id));
    // A variant's metafields beyond its first page (Phase 3, task 2).
    for (const edge of edgesOf(node, "variants")) {
      const variant = (edge as Raw | null)?.node as Raw | undefined;
      if (variant && typeof variant.id === "string") await allPages(gql, variant, "metafields", VARIANT_METAFIELDS_PAGE, variant.id);
    }
    return unitFromNode(node);
  }
  if (kind === "inventory") {
    const node = (await gql<{ node: Raw | null }>(INVENTORY_ITEM_BY_ID, { id: gid("InventoryItem", id) })).node;
    if (!node) return null;
    await allPages(gql, node, "inventoryLevels", INVENTORY_ITEM_BY_ID, gid("InventoryItem", id));
    return unitFromNode(node);
  }
  const node = (await gql<{ node: Raw | null }>(RETURN_BY_ID, { id: gid("Return", id) })).node;
  const orderId = (node?.order as Raw | undefined)?.id;
  if (!node || typeof orderId !== "string") return null;
  await allPages(gql, node, "returnLineItems", RETURN_BY_ID, gid("Return", id));
  // As a returns export gives it: the order, its return, the return's lines and its refunds (task 4).
  const { order: _order, returnLineItems: _lines, refunds: _refunds, ...fields } = node;
  void _order; void _lines; void _refunds;
  const lines = edgesOf(node, "returnLineItems").map((edge) => ({ ...((edge as Raw).node as Raw), __parentId: node.id }));
  const refunds = edgesOf(node, "refunds").map((edge) => ({ ...((edge as Raw).node as Raw), __parentId: node.id }));
  return { root: { id: orderId }, children: [{ ...fields, __parentId: orderId }, ...lines, ...refunds], firstLine: 0, lastLine: 0 };
}

async function fetchCustomers(gql: Gql, ids: number[]): Promise<Map<number, JsonlUnit | null>> {
  const found = new Map<number, JsonlUnit | null>();
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const nodes = (await gql<{ nodes: Array<Raw | null> }>(CUSTOMERS_BY_ID, { ids: slice.map((id) => gid("Customer", id)) })).nodes;
    slice.forEach((id, index) => found.set(id, nodes[index] ? unitFromNode(nodes[index] as Raw) : null));
  }
  return found;
}

/** The line items of each refund, for refunds on orders before the window (rare: one query per refund). */
async function fetchRefundLines(gql: Gql, refundIds: number[]): Promise<RefundLineRow[]> {
  const rows: RefundLineRow[] = [];
  for (const id of refundIds) {
    const node = (await gql<{ node: Raw | null }>(REFUND_LINES_BY_ID, { id: gid("Refund", id) })).node;
    if (!node) continue;
    await allPages(gql, node, "refundLineItems", REFUND_LINES_BY_ID, gid("Refund", id));
    rows.push(...mapRefundLines(id, edgesOf(node, "refundLineItems").map((edge) => (edge as Raw).node)));
  }
  return rows;
}

/** Writes one kind of fetched resources; returns the orders whose history arrivals must wait for an import to finish. */
async function writeKind(kind: SyncKind, units: JsonlUnit[], shop: { shopKey: number; shopifyShopId: number }, writes: SyncDeps["writes"], gql: Gql): Promise<Set<number>> {
  const deferred = new Set<number>();
  for (const chunk of chunkUnits(units, WRITE_ROWS)) {
    if (kind === "order") {
      const mapped = chunk.map(mapOrderUnit);
      const written = await writes.writeOrders(shop.shopKey, shop.shopifyShopId, {
        orders: mapped.flatMap((m) => (m.order ? [m.order] : [])), lineItems: mapped.flatMap((m) => m.lineItems), refunds: mapped.flatMap((m) => m.refunds),
      });
      if (!Number(written?.beyond_window ?? 0)) continue;
      // Orders before the window: late ones become adjustments to their history months (0042).
      const windowStart = await writes.historyWindowStart(shop.shopKey);
      const history = mapped.filter((m): m is typeof m & { order: OrderRow } => m.order !== null && Date.parse(m.order.processed_at) < windowStart);
      if (!history.length) continue;
      const refundLines = await fetchRefundLines(gql, history.flatMap((m) => m.refunds.map((r) => r.shopify_id)));
      const result = await writes.writeHistoryArrivals(shop.shopKey, shop.shopifyShopId, {
        orders: history.map((m) => m.order), lineItems: history.flatMap((m) => m.lineItems), refunds: history.flatMap((m) => m.refunds), refundLines,
      });
      if (result.deferred) for (const m of history) deferred.add(m.order.shopify_id);
    } else if (kind === "product") {
      const mapped = chunk.map(mapProductUnit);
      await writes.writeCatalog(shop.shopKey, {
        products: mapped.flatMap((m) => (m.product ? [m.product] : [])), variants: mapped.flatMap((m) => m.variants), metafields: mapped.flatMap((m) => m.metafields),
      });
    } else if (kind === "customer") {
      await writes.writeCustomers(shop.shopKey, shop.shopifyShopId, chunk.map(mapCustomerUnit).filter((c): c is NonNullable<typeof c> => c !== null));
    } else if (kind === "inventory") {
      // A by-ID read is the item's current, complete list of levels, with their locations in full (task 3).
      const locations = [...new Map(chunk.flatMap(mapInventoryLocations).map((l) => [l.shopify_id, l])).values()];
      const completeItems = chunk.flatMap((unit) => {
        const id = Number(String(unit.root.id ?? "").split("/").pop());
        return Number.isSafeInteger(id) && id > 0 ? [id] : [];
      });
      await writes.writeInventory(shop.shopKey, { locations, levels: chunk.flatMap(mapInventoryUnit), completeItems });
    } else {
      const mapped = chunk.map(mapReturnsUnit);
      await writes.writeReturns(shop.shopKey, {
        returns: mapped.flatMap((m) => m.returns), lineItems: mapped.flatMap((m) => m.lineItems), returnRefunds: mapped.flatMap((m) => m.returnRefunds),
      });
    }
  }
  return deferred;
}

export interface SyncReport {
  outcome: "drained" | "budget" | "not_ingestible" | "no_access";
  events: number;
  resources: Partial<Record<SyncKind, number>>;
  deleted: number;
  processed: number;
  failed: number;
  dead: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message.slice(0, 500) : "unknown");

export async function processShopEvents(shopDomain: string, runId: string, deps: SyncDeps, { budgetMs = 480_000, batchSize = 100 } = {}): Promise<SyncReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const report: SyncReport = { outcome: "drained", events: 0, resources: {}, deleted: 0, processed: 0, failed: 0, dead: 0 };
  const shop = await deps.shop(shopDomain);
  if (!shop) return { ...report, outcome: "not_ingestible" };
  const gql = await deps.gql(shopDomain);
  // Without access the events stay as they are and the sweep tries again later.
  if (!gql) return { ...report, outcome: "no_access" };

  for (;;) {
    if (now() - started >= budgetMs) {
      report.outcome = "budget";
      break;
    }
    const events = await deps.repo.claimSyncEvents(shop.shopKey, runId, batchSize);
    if (!events.length) break;
    report.events += events.length;
    const { resources, unusable } = groupResources(events);
    const processed = [...unusable];
    const failed: Array<{ id: string; error: string }> = [];

    const byKind = new Map<SyncKind, SyncResource[]>();
    for (const resource of resources) byKind.set(resource.kind, [...(byKind.get(resource.kind) ?? []), resource]);
    for (const [kind, group] of byKind) {
      report.resources[kind] = (report.resources[kind] ?? 0) + group.length;
      const found: JsonlUnit[] = [];
      const missing: SyncResource[] = [];
      const fetched: SyncResource[] = [];
      try {
        const customers = kind === "customer" ? await fetchCustomers(gql, group.map((r) => r.id)) : null;
        for (const resource of group) {
          try {
            const unit = customers ? customers.get(resource.id) ?? null : await fetchOne(gql, kind as Exclude<SyncKind, "customer">, resource.id);
            if (unit) found.push(unit);
            else missing.push(resource);
            fetched.push(resource);
          } catch (error) {
            for (const id of resource.eventIds) failed.push({ id, error: message(error) });
          }
        }
        const deferred = found.length ? await writeKind(kind, found, shop, deps.writes, gql) : new Set<number>();
        if (kind === "order" && found.length && deps.refundLines) {
          // Refunds' lines are read again daily if this fails; the orders themselves are written.
          await deps.refundLines(gql, shop.shopKey).catch((error) => log.warn("Refund lines not read", { shop: shopDomain }, error));
        }
        if (kind === "product" && found.length && deps.references) {
          // References are repaired daily if this fails; the products themselves are written.
          await deps.references(gql, shop.shopKey).catch((error) => log.warn("Catalog references not read", { shop: shopDomain }, error));
        }
        if (missing.length && (kind === "order" || kind === "product" || kind === "customer")) {
          report.deleted += (await deps.repo.deleteSyncedRecords(shop.shopKey, kind, missing.map((r) => r.id))).deleted;
        }
        for (const resource of fetched) {
          // Written, but its history arrival waits for the import in progress: tried again with backoff.
          if (deferred.has(resource.id)) for (const id of resource.eventIds) failed.push({ id, error: "history_import_active" });
          else processed.push(...resource.eventIds);
        }
      } catch (error) {
        log.warn("Sync write failed", { shop: shopDomain, kind }, error);
        for (const resource of fetched) for (const id of resource.eventIds) failed.push({ id, error: message(error) });
      }
    }
    const finished = await deps.repo.finishSyncEvents(runId, processed, failed);
    report.processed += finished.processed;
    report.failed += finished.failed;
    report.dead += finished.dead;
  }
  if (report.events) log.info("Shop sync events processed", { shop: shopDomain, ...report, resources: JSON.stringify(report.resources) });
  return report;
}

export interface ReconcileDeps {
  shop: SyncDeps["shop"];
  gql: SyncDeps["gql"];
  repo: Pick<typeof SyncRepository, "loadSyncWatermark" | "lastImportStart" | "recordSyncEvents" | "saveSyncWatermark">;
}

const RECONCILED = [
  { domain: "orders", connection: "orders", topic: "orders/updated", importDomain: "orders" },
  { domain: "catalog", connection: "products", topic: "products/update", importDomain: "catalog" },
  { domain: "customers", connection: "customers", topic: "customers/update", importDomain: "customers" },
] as const;

export type ReconcileReport = Record<(typeof RECONCILED)[number]["domain"], { found: number; recorded: number; watermark: string | null; truncated?: boolean; skipped?: string }>;

export interface ReconcileOptions {
  overlapMs?: number;
  maxPerDomain?: number;
  /**
   * A replay: every change since this time, recorded under the tag's own event IDs, so changes already
   * processed are processed again (after a fix, for example). The watermarks still only move forward.
   */
  replay?: { since: string; tag: string; domains?: ReadonlyArray<(typeof RECONCILED)[number]["domain"]> };
}

export async function reconcileShopUpdates(shopDomain: string, deps: ReconcileDeps, { overlapMs = 3_600_000, maxPerDomain = 10_000, replay }: ReconcileOptions = {}): Promise<ReconcileReport | { skipped: string }> {
  if (replay && (!/^[a-z0-9-]{1,40}$/.test(replay.tag) || Number.isNaN(Date.parse(replay.since)))) throw new Error("replay needs a tag (a-z, 0-9, -) and a date");
  const shop = await deps.shop(shopDomain);
  if (!shop) return { skipped: "not_ingestible" };
  const gql = await deps.gql(shopDomain);
  if (!gql) return { skipped: "no_access" };
  const report = {} as ReconcileReport;
  for (const spec of RECONCILED) {
    if (replay?.domains && !replay.domains.includes(spec.domain)) {
      report[spec.domain] = { found: 0, recorded: 0, watermark: null, skipped: "not_requested" };
      continue;
    }
    const from = replay?.since ?? (await deps.repo.loadSyncWatermark(shop.shopKey, spec.domain)) ?? (await deps.repo.lastImportStart(shop.shopId, spec.importDomain));
    if (!from) {
      report[spec.domain] = { found: 0, recorded: 0, watermark: null, skipped: "not_imported" };
      continue;
    }
    const query = searchFilter([["updated_at", ">=", new Date(Date.parse(from) - (replay ? 0 : overlapMs))]]);
    const found: Array<{ id: number; updatedAt: string }> = [];
    let after: string | null = null;
    let truncated = false;
    for (;;) {
      const data: { [key: string]: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; updatedAt: string }> } } =
        await gql(updatedSinceQuery(spec.connection), { query, after });
      const connection = data[spec.connection];
      for (const node of connection.nodes) found.push({ id: Number(node.id.split("/").pop()), updatedAt: node.updatedAt });
      if (!connection.pageInfo.hasNextPage) break;
      if (found.length >= maxPerDomain) {
        truncated = true;
        break;
      }
      after = connection.pageInfo.endCursor;
    }
    let recorded = 0;
    for (let i = 0; i < found.length; i += 500) {
      const events = found.slice(i, i + 500).map((item) => ({
        webhook_id: `reconcile:${replay ? `${replay.tag}:` : ""}${spec.topic}:${item.id}:${item.updatedAt}`, topic: spec.topic, triggered_at: item.updatedAt,
        payload: { id: item.id, updated_at: item.updatedAt },
      }));
      recorded += (await deps.repo.recordSyncEvents(shopDomain, events)).recorded;
    }
    // Oldest change first: when truncated, the next run continues from the last change seen.
    const newest = found.length ? found[found.length - 1].updatedAt : from;
    const saved = await deps.repo.saveSyncWatermark(shop.shopKey, spec.domain, newest);
    report[spec.domain] = { found: found.length, recorded, watermark: saved.watermark, ...(truncated ? { truncated } : {}) };
  }
  return report;
}
