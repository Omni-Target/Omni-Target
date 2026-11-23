import "server-only";
import { collectDeniedFields, shopifyGraphql } from "@/lib/connectors/shopify-graphql";
import { releaseImportCapacity, renewImportCapacity, reserveImportCapacity } from "@/modules/capacity/service";
import { importCounts, sampledRatios, type ImportDomain } from "@/modules/capacity/projection";
import { suppressionKey } from "@/modules/compliance/suppression";
import { getShopifyAccessForShop } from "@/modules/credentials/shopify";
import { refreshSummaryMonth } from "@/modules/retention/repository";
import { createLogger } from "@/platform/logger";
import { checkShopAccess } from "./access-check";
import { resumableCheckpoint } from "./checkpoint";
import type { DataDomain } from "./access";
import { bulkPhase, getBulkOperation, openBulkResult, pollDelayMs, ResultUnavailableError, startBulkQuery, type Gql } from "./bulk";
import { withOrderDigests } from "./digests";
import * as imports from "./imports";
import type { JsonlUnit } from "./jsonl";
import { mapCustomerUnit, mapInventoryUnit, mapLocation, mapOrderUnit, mapProductUnit, mapReturnsUnit } from "./mappers";
import { BULK_QUERIES, LOCATIONS_QUERY, searchFilter } from "./queries";
import { deleteStaged, openStaged, r2StagingStore, shouldStage, stageStream, stagingKey } from "./staging";
import { IncompleteResultError, streamImport } from "./stream-import";
import { deriveCustomerFacts, loadCheckpoint, saveCheckpoint, writeCatalog, writeCustomers, writeInventory, writeOrders, writeReturns } from "./writes";

/**
 * The initial import of one shop (Phase 2, task 6), run by the shop-import
 * Trigger.dev task. Every step is idempotent, so a retried or taken-over run
 * repeats safely: writes are newer-wins upserts, staging ignores duplicates,
 * summaries never change once final, and each domain resumes from its
 * checkpoint while the same bulk operation's result is still available.
 */
const log = createLogger({ module: "shop-import" });

/** Units per write batch; a unit is a record with its children. */
const BATCH_ROWS = 1_000;
const HEARTBEAT_EVERY = 10;
const MAX_RERUNS = 2;

export class ImportStopped extends Error {
  constructor(readonly reason: "lost" | "capacity" | "not_ingestible") {
    super(`Import stopped: ${reason}`);
    this.name = "ImportStopped";
  }
}

type Stats = Record<string, number>;
const add = (into: Stats, from: Record<string, unknown> | null | undefined) => {
  for (const [key, value] of Object.entries(from ?? {})) if (typeof value === "number") into[key] = (into[key] ?? 0) + value;
};

export interface DomainCoverage {
  status: "succeeded" | "failed" | "skipped";
  records?: number;
  units?: number;
  rejected?: number;
  written?: Stats;
  staged?: boolean;
  reason?: string;
}

interface Context {
  importId: string;
  runId: string;
  shopKey: number;
  shopDomain: string;
  shopifyShopId: number;
  windowStart: Date;
  /** When the import first started: only checkpoints written since then may be resumed. */
  startedAt: Date;
  /** The domains this import covers; null: all (0039). */
  scope: ReadonlySet<ImportDomain> | null;
  gql: Gql;
  sleep: (ms: number) => Promise<void>;
  reservationId: string | null;
  rowsWritten: number;
  batches: number;
  coverage: Record<string, unknown>;
}

async function keepAlive(ctx: Context): Promise<void> {
  const beat = await imports.importHeartbeat(ctx.importId, ctx.runId, ctx.coverage);
  if (beat.outcome === "lost") throw new ImportStopped("lost");
  if (ctx.reservationId) {
    const renewed = await renewImportCapacity(ctx.reservationId, ctx.rowsWritten * 300);
    if (renewed.overLimit) throw new ImportStopped("capacity");
  }
}

/** Runs one bulk query to completion and streams it through `write`, resuming or re-running as needed. */
async function importBulk(
  ctx: Context,
  checkpointDomain: DataDomain | null,
  query: string,
  write: (units: JsonlUnit[]) => Promise<{ rows: number; rejected: number; stats?: Record<string, unknown> }>,
): Promise<DomainCoverage> {
  const written: Stats = {};
  let rejected = 0;
  let previousFailed = false;
  const saved = checkpointDomain ? await loadCheckpoint(ctx.shopKey, checkpointDomain) : null;
  let resume = resumableCheckpoint(saved, ctx.startedAt);

  for (let attempt = 0; attempt <= MAX_RERUNS; attempt++) {
    let operationId: string;
    let skipThroughLine = 0;
    const resumed = resume ? await getBulkOperation(ctx.gql, resume.operationId) : null;
    if (resume && resumed && bulkPhase(resumed).phase === "completed") {
      operationId = resume.operationId;
      skipThroughLine = resume.line;
    } else {
      let started = await startBulkQuery(ctx.gql, query);
      for (let wait = 0; started.outcome === "busy" && wait < 30; wait++) {
        await ctx.sleep(pollDelayMs(wait));
        started = await startBulkQuery(ctx.gql, query);
      }
      if (started.outcome !== "started") return { status: "failed", reason: started.outcome === "rejected" ? started.errors.join("; ").slice(0, 300) : started.outcome };
      operationId = started.id;
    }
    resume = null;

    let operation = await getBulkOperation(ctx.gql, operationId);
    for (let poll = 0; operation && bulkPhase(operation).phase === "pending"; poll++) {
      await ctx.sleep(pollDelayMs(poll));
      operation = await getBulkOperation(ctx.gql, operationId);
      if (poll % 6 === 5) await keepAlive(ctx);
    }
    if (!operation) return { status: "failed", reason: "operation_missing" };
    const phase = bulkPhase(operation);
    if (phase.phase === "rerun") { previousFailed = true; continue; }
    // A failed operation's partial data is never read: missing records would look like deletions.
    if (phase.phase === "failed") return { status: "failed", reason: phase.accessDenied ? "access_denied" : phase.reason };
    if (phase.phase !== "completed") return { status: "failed", reason: "unexpected_phase" };
    const numericId = Number(operationId.split("/").pop());
    if (!phase.url) {
      if (checkpointDomain) await saveCheckpoint(ctx.shopKey, checkpointDomain, { syncRunId: null, bulkOperationId: numericId, committedLine: 0, watermark: null });
      return { status: "succeeded", records: 0, units: 0, rejected: 0, written };
    }

    const stage = shouldStage({ fileSize: operation.fileSize, previousAttemptFailed: previousFailed });
    const store = stage ? r2StagingStore() : null;
    const key = stage ? stagingKey({ shopKey: ctx.shopKey, syncRunId: ctx.importId, domain: checkpointDomain ?? "orders", bulkOperationId: numericId }) : null;
    try {
      if (store && key) await stageStream(store, key, await openBulkResult(phase.url));
      const source = store && key ? await openStaged(store, key) : await openBulkResult(phase.url);
      const result = await streamImport({
        source,
        expectedObjects: operation.objectCount,
        maxRows: BATCH_ROWS,
        skipThroughLine,
        write: async (units) => {
          const outcome = await write(units);
          rejected += outcome.rejected;
          add(written, outcome.stats);
          ctx.rowsWritten += outcome.rows;
          if (++ctx.batches % HEARTBEAT_EVERY === 0) await keepAlive(ctx);
        },
        checkpoint: async (line) => {
          if (checkpointDomain) await saveCheckpoint(ctx.shopKey, checkpointDomain, { syncRunId: null, bulkOperationId: numericId, committedLine: line, watermark: null });
        },
      });
      return { status: "succeeded", records: result.records, units: result.units, rejected, written, staged: stage };
    } catch (error) {
      if (error instanceof ResultUnavailableError || error instanceof IncompleteResultError) {
        log.warn("Bulk result unusable; re-running", { shop: ctx.shopDomain, domain: checkpointDomain, reason: error.message });
        previousFailed = true;
        continue;
      }
      throw error;
    } finally {
      if (store && key) {
        const gone = await deleteStaged(store, key).catch(() => false);
        if (!gone) log.warn("Staged result not deleted; the sweep will remove it", { shop: ctx.shopDomain, key });
      }
    }
  }
  return { status: "failed", reason: "result_unavailable_after_reruns" };
}

const COUNTS_QUERY = `query ImportCounts($window: String!, $history: String!) {
  productsCount(limit: null) { count }
  productVariantsCount(limit: null) { count }
  customersCount(limit: null) { count }
  window: ordersCount(query: $window, limit: null) { count }
  history: ordersCount(query: $history, limit: null) { count }
  oldest: orders(first: 1, sortKey: PROCESSED_AT) { nodes { processedAt } }
  sampleProducts: products(first: 25) { nodes { metafields(first: 20) { nodes { id } } } }
  sampleVariants: productVariants(first: 25) { nodes { inventoryItem { inventoryLevels(first: 10) { nodes { id } } } } }
}`;

interface CountsData {
  productsCount: { count: number }; productVariantsCount: { count: number }; customersCount: { count: number };
  window: { count: number }; history: { count: number }; oldest: { nodes: Array<{ processedAt: string }> };
  sampleProducts: { nodes: Array<{ metafields: { nodes: unknown[] } }> };
  sampleVariants: { nodes: Array<{ inventoryItem: { inventoryLevels: { nodes: unknown[] } } | null }> };
}

const monthsBetween = (from: Date, to: Date) => Math.max(1, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth() + 1);
const firstOfMonth = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
const isoDate = (at: Date) => at.toISOString().slice(0, 10);

export interface ImportReport {
  outcome: "succeeded" | "partial" | "failed" | "finished" | "busy" | "missing";
  coverage?: Record<string, unknown>;
}

/**
 * How an import reaches Shopify: the live session, GraphQL client and access check by default. The
 * scale verification (task 12) passes a fake Shopify serving generated bulk results instead.
 */
export interface ImportDeps {
  access: typeof getShopifyAccessForShop;
  gql: (shopDomain: string, accessToken: string) => Gql;
  checkAccess: (shopDomain: string) => ReturnType<typeof checkShopAccess>;
}
const liveImportDeps: ImportDeps = {
  access: getShopifyAccessForShop,
  gql: (shopDomain, accessToken) => (query, variables) => shopifyGraphql(shopDomain, accessToken, query, variables),
  checkAccess: (shopDomain) => checkShopAccess(shopDomain),
};

export async function runShopImport(importId: string, runId: string, sleep: (ms: number) => Promise<void>, deps: ImportDeps = liveImportDeps): Promise<ImportReport> {
  const claim = await imports.claimImport(importId, runId);
  if (claim.outcome !== "claimed") return { outcome: claim.outcome };

  const access = await deps.access(claim.shop_domain);
  const finish = async (status: "succeeded" | "partial" | "failed", coverage: Record<string, unknown>, error: string | null) => {
    await imports.finishImport(importId, runId, status, coverage, error);
    return { outcome: status, coverage } as ImportReport;
  };
  if (access.status !== "ok") return finish("failed", { access: access.status }, `no_access:${access.status}`);

  const ctx: Context = {
    importId, runId, shopKey: claim.shop_key, shopDomain: claim.shop_domain, shopifyShopId: Number(claim.shopify_shop_id),
    windowStart: new Date(claim.window_start), startedAt: await imports.importStartedAt(importId), scope: claim.domains?.length ? new Set(claim.domains) : null, gql: deps.gql(claim.shop_domain, access.accessToken), sleep,
    reservationId: null, rowsWritten: 0, batches: 0, coverage: { started_at: new Date().toISOString() },
  };

  try {
    const accessCheck = await deps.checkAccess(ctx.shopDomain);
    if (accessCheck.outcome !== "checked") return finish("failed", ctx.coverage, `access_check:${accessCheck.outcome}`);
    const domains = accessCheck.report.domains;
    const historyAllowed = domains.orders.history?.basis === "retention_window";

    const windowFilter = searchFilter([["processed_at", ">=", ctx.windowStart]]);
    const historyFilter = searchFilter([["processed_at", "<", ctx.windowStart]]);
    const { value: counts } = await collectDeniedFields(() => ctx.gql<CountsData>(COUNTS_QUERY, { window: windowFilter, history: historyFilter }));
    const oldest = counts.oldest.nodes[0]?.processedAt ? new Date(counts.oldest.nodes[0].processedAt) : new Date();
    const ratios = sampledRatios({
      products: counts.sampleProducts.nodes.length,
      metafields: counts.sampleProducts.nodes.reduce((n, p) => n + p.metafields.nodes.length, 0),
      variants: counts.sampleVariants.nodes.length,
      inventoryLevels: counts.sampleVariants.nodes.reduce((n, v) => n + (v.inventoryItem?.inventoryLevels.nodes.length ?? 0), 0),
    });
    const shopCounts = {
      products: counts.productsCount.count, variants: counts.productVariantsCount.count, customers: counts.customersCount.count,
      ordersInWindow: counts.window.count, ordersBeyondWindow: historyAllowed ? counts.history.count : 0,
      monthsOfHistory: monthsBetween(oldest, new Date()), ...ratios,
    };
    ctx.coverage.counts = shopCounts;

    // Only what this import writes is reserved: a scoped re-import of orders does not reserve for the catalog.
    const reservation = await reserveImportCapacity(ctx.shopKey, "initial_import", importCounts(shopCounts, ctx.scope));
    ctx.coverage.capacity = reservation;
    if (reservation.outcome === "refused") return finish("failed", ctx.coverage, "capacity_refused");
    ctx.reservationId = reservation.reservationId;

    const key = suppressionKey();
    const results: Record<string, DomainCoverage> = {};
    const inScope = (name: string) => !ctx.scope || ctx.scope.has((name === "history" ? "orders" : name) as ImportDomain);
    ctx.coverage.scope = ctx.scope ? [...ctx.scope] : "all";
    const run = async (name: string, accessible: boolean, step: () => Promise<DomainCoverage>) => {
      if (!inScope(name)) { results[name] = { status: "skipped", reason: "not_in_scope" }; return; }
      if (!accessible) { results[name] = { status: "skipped", reason: "inaccessible" }; return; }
      try {
        results[name] = await step();
      } catch (error) {
        if (error instanceof ImportStopped) throw error;
        results[name] = { status: "failed", reason: error instanceof Error ? error.message.slice(0, 300) : "unknown" };
        log.warn("Import domain failed", { shop: ctx.shopDomain, domain: name, reason: results[name].reason });
      }
      ctx.coverage.domains = results;
      await keepAlive(ctx);
    };

    await run("catalog", domains.catalog.status !== "inaccessible", () => importBulk(ctx, "catalog", BULK_QUERIES.catalog(), async (units) => {
      const mapped = units.map(mapProductUnit);
      const batch = { products: mapped.flatMap((m) => (m.product ? [m.product] : [])), variants: mapped.flatMap((m) => m.variants), metafields: mapped.flatMap((m) => m.metafields) };
      const stats = await writeCatalog(ctx.shopKey, batch);
      return { rows: batch.products.length + batch.variants.length + batch.metafields.length, rejected: units.length - batch.products.length, stats };
    }));

    await run("inventory", domains.inventory.status !== "inaccessible", async () => {
      const locations = [];
      for (let after: string | null = null, page = 0; page < 40; page++) {
        const data: { locations: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await ctx.gql(LOCATIONS_QUERY, { after });
        locations.push(...data.locations.nodes.map(mapLocation).filter((l): l is NonNullable<typeof l> => l !== null));
        if (!data.locations.pageInfo.hasNextPage) break;
        after = data.locations.pageInfo.endCursor;
      }
      await writeInventory(ctx.shopKey, { locations, levels: [] });
      const result = await importBulk(ctx, "inventory", BULK_QUERIES.inventory(), async (units) => {
        const levels = units.flatMap(mapInventoryUnit);
        const stats = await writeInventory(ctx.shopKey, { locations: [], levels });
        return { rows: levels.length, rejected: 0, stats };
      });
      return { ...result, written: { ...(result.written ?? {}), locations: locations.length } };
    });

    await run("customers", domains.customers.status !== "inaccessible", () => importBulk(ctx, "customers", BULK_QUERIES.customers(), async (units) => {
      const rows = units.map(mapCustomerUnit).filter((c): c is NonNullable<typeof c> => c !== null);
      const stats = await writeCustomers(ctx.shopKey, ctx.shopifyShopId, rows, key);
      return { rows: rows.length, rejected: units.length - rows.length, stats };
    }));

    await run("orders", domains.orders.status !== "inaccessible", () => importBulk(ctx, "orders", BULK_QUERIES.orders(windowFilter), async (units) => {
      const mapped = units.map(mapOrderUnit);
      const batch = { orders: mapped.flatMap((m) => (m.order ? [m.order] : [])), lineItems: mapped.flatMap((m) => m.lineItems), refunds: mapped.flatMap((m) => m.refunds) };
      const stats = await writeOrders(ctx.shopKey, ctx.shopifyShopId, batch, key);
      return { rows: batch.orders.length + batch.lineItems.length + batch.refunds.length, rejected: units.length - batch.orders.length, stats };
    }));

    // History beyond the window: staged, summarised month by month, discarded (decision 3).
    if (historyAllowed && counts.history.count > 0 && inScope("history")) {
      await run("history", domains.orders.status !== "inaccessible", async () => {
        const staged = await importBulk(ctx, null, BULK_QUERIES.orders(historyFilter), async (units) => {
          const mapped = units.map(mapOrderUnit);
          const orders = withOrderDigests(mapped.flatMap((m) => (m.order ? [m.order] : [])), key, ctx.shopifyShopId);
          const lines = mapped.flatMap((m) => m.lineItems);
          const stats = await imports.stageHistory(ctx.importId, ctx.runId, orders, lines);
          return { rows: 0, rejected: units.length - orders.length, stats };
        });
        if (staged.status !== "succeeded") return staged;
        const summarised: Stats = {};
        for (const { month } of await imports.historyMonths(ctx.importId)) add(summarised, await imports.summariseHistoryMonth(ctx.importId, ctx.runId, month));
        const discarded = await imports.discardHistory(ctx.importId, ctx.runId);
        return { ...staged, written: { ...(staged.written ?? {}), ...summarised, discarded } };
      });
    } else {
      results.history = { status: "skipped", reason: !inScope("history") ? "not_in_scope" : historyAllowed ? "no_orders_before_window" : "read_all_orders_not_granted" };
    }

    await run("returns", domains.returns.status !== "inaccessible", () => importBulk(ctx, "returns", BULK_QUERIES.returns(windowFilter), async (units) => {
      const mapped = units.map(mapReturnsUnit);
      const batch = { returns: mapped.flatMap((m) => m.returns), lineItems: mapped.flatMap((m) => m.lineItems) };
      if (!batch.returns.length) return { rows: 0, rejected: 0 };
      const stats = await writeReturns(ctx.shopKey, batch);
      return { rows: batch.returns.length + batch.lineItems.length, rejected: 0, stats };
    }));

    // Customers' first and last orders, then the retained window's summaries, one month per call.
    const facts: Stats = {};
    for (let after = 0, i = 0; i < 1_000; i++) {
      const step = await deriveCustomerFacts(ctx.shopKey, after, 2_000);
      add(facts, { updated: step.updated });
      if (step.next_after === null) break;
      after = step.next_after;
    }
    // Only from complete orders: a month summarised from a partial import would become final with gaps.
    const summaries: Stats = {};
    if (results.orders?.status === "succeeded") {
      for (let month = firstOfMonth(ctx.windowStart); month <= new Date(); month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
        add(summaries, await refreshSummaryMonth(ctx.shopKey, isoDate(month)));
      }
    }
    ctx.coverage.customer_facts = facts;
    ctx.coverage.window_summaries = results.orders?.status === "succeeded" ? summaries : { skipped: "orders_incomplete" };
    ctx.coverage.domains = results;
    ctx.coverage.rows_written = ctx.rowsWritten;
    ctx.coverage.finished_at = new Date().toISOString();

    const statuses = Object.values(results).map((r) => r.status);
    const status = statuses.every((s) => s !== "failed") ? "succeeded" : statuses.some((s) => s === "succeeded") ? "partial" : "failed";
    await releaseImportCapacity(ctx.reservationId, status === "failed" ? "failed" : "completed");
    log.info("Shop import finished", { shop: ctx.shopDomain, status, rows: ctx.rowsWritten });
    return finish(status, ctx.coverage, null);
  } catch (error) {
    const reason = error instanceof ImportStopped ? error.reason : error instanceof Error ? error.message.slice(0, 500) : "unknown";
    if (ctx.reservationId) await releaseImportCapacity(ctx.reservationId, "failed").catch(() => {});
    if (error instanceof ImportStopped && error.reason === "lost") return { outcome: "busy" };
    await imports.discardHistory(importId, runId).catch(() => 0);
    if (error instanceof ImportStopped) return finish("partial", ctx.coverage, reason);
    throw error;
  }
}
