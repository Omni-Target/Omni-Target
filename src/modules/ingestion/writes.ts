import "server-only";
import { suppressionKey } from "@/modules/compliance/suppression";
import { supabaseAdmin } from "@/platform/supabase";
import { withCustomerDigests, withOrderDigests, withRefundDigests } from "./digests";
import type { DataDomain } from "./access";
import type {
  CustomerRow, InventoryLevelRow, LineItemRow, LocationRow, MetafieldDefinitionRow, MetafieldRow, MetaobjectDefinitionRow, MetaobjectRow,
  OrderRow, ProductRow, RefundLineRow, RefundRow, ReturnLineItemRow, ReturnRow, VariantRow,
} from "./mappers";

/**
 * Writes into the commerce mirror (migration 0032). Every call is one bounded
 * batch (at most 2,000 rows) in one transaction, admitted only for a shop
 * bound to an active workspace.
 */
export const MAX_BATCH_ROWS = 2_000;

export class IngestWriteError extends Error {
  readonly notIngestible: boolean;
  constructor(readonly fn: string, message: string) {
    super(`${fn}: ${message}`);
    this.name = "IngestWriteError";
    this.notIngestible = message.includes("shop_not_ingestible");
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new IngestWriteError(fn, error.message);
  return data as T;
}

export const writeCatalog = (shopKey: number, batch: { products: ProductRow[]; variants: VariantRow[]; metafields: MetafieldRow[] }) =>
  rpc<Record<string, number>>("ingest_catalog", {
    p_shop_key: shopKey, p_products: batch.products, p_variants: batch.variants, p_metafields: batch.metafields,
  });

/** The shop's metafield and metaobject definitions, replacing what is stored (0044). */
export const writeCatalogDefinitions = (shopKey: number, batch: { metafieldDefinitions: MetafieldDefinitionRow[]; metaobjectDefinitions: MetaobjectDefinitionRow[] }) =>
  rpc<Record<string, number>>("replace_catalog_definitions", {
    p_shop_key: shopKey, p_metafield_definitions: batch.metafieldDefinitions, p_metaobject_definitions: batch.metaobjectDefinitions,
  });

/** Referenced metaobjects as read, and those Shopify no longer has (0044). */
export const writeMetaobjects = (shopKey: number, metaobjects: MetaobjectRow[], deleted: number[]) =>
  rpc<Record<string, number>>("ingest_metaobjects", { p_shop_key: shopKey, p_metaobjects: metaobjects, p_deleted: deleted });

/** Referenced metaobjects not stored yet, or read before staleBefore (0044). */
export const catalogReferenceIds = async (shopKey: number, staleBefore: Date | null, limit = 250): Promise<number[]> =>
  (await rpc<Array<number | string>>("catalog_reference_ids", { p_shop_key: shopKey, p_stale_before: staleBefore?.toISOString() ?? null, p_limit: limit }))
    .map(Number);

/** Each stored metaobject definition's display-name field, by type. */
export async function metaobjectDisplayKeys(shopKey: number): Promise<Map<string, string | null>> {
  const { data, error } = await supabaseAdmin.from("metaobject_definitions").select("type, display_name_key").eq("shop_key", shopKey).limit(1000);
  if (error) throw new IngestWriteError("metaobject_definitions", error.message);
  return new Map((data ?? []).map((d) => [String(d.type), (d.display_name_key as string | null) ?? null]));
}

/**
 * Refreshes the planner's statistics of mirror tables an import has just written (0045), one table per call,
 * so a new shop's per-shop statements are planned for its real size. Never fatal: autovacuum catches up later.
 */
export async function refreshMirrorStatistics(tables: readonly string[]): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  for (const table of tables) {
    try {
      out[table] = Number((await rpc<{ ms: number }>("refresh_mirror_statistics", { p_table: table })).ms);
    } catch (error) {
      out[table] = error instanceof Error ? error.message.slice(0, 120) : "failed";
    }
  }
  return out;
}

/**
 * Locations and inventory levels. completeItems: items whose full, current list of levels the batch holds (a
 * by-ID read), so levels at locations they no longer stock are removed (0046). A bulk export never passes it.
 */
export const writeInventory = (shopKey: number, batch: { locations: LocationRow[]; levels: InventoryLevelRow[]; completeItems?: number[] }) =>
  rpc<Record<string, number>>("ingest_inventory", {
    p_shop_key: shopKey, p_locations: batch.locations, p_levels: batch.levels, p_complete_items: batch.completeItems ?? null,
  });

export const writeOrders = (
  shopKey: number,
  shopifyShopId: number,
  batch: { orders: OrderRow[]; lineItems: LineItemRow[]; refunds: RefundRow[] },
  key: Buffer = suppressionKey(),
) =>
  rpc<Record<string, number>>("ingest_orders", {
    p_shop_key: shopKey,
    p_orders: withOrderDigests(batch.orders, key, shopifyShopId),
    p_line_items: batch.lineItems,
    p_refunds: batch.refunds,
  });

/** The shop's retained window start (pinned while an import runs), in milliseconds. */
export const historyWindowStart = async (shopKey: number): Promise<number> =>
  Date.parse(String(await rpc<string>("shop_window_start", { p_shop_key: shopKey })));

export interface HistoryArrivalResult {
  history_orders: number;
  orders_applied?: number;
  refunds_applied?: number;
  /** An import is in progress: nothing was applied, and the caller tries again later. */
  deferred?: boolean;
  skipped?: string;
}
/** Late arrivals among orders from before the window (0042): adjustments to the history months they belong to. */
export const writeHistoryArrivals = (
  shopKey: number,
  shopifyShopId: number,
  batch: { orders: OrderRow[]; lineItems: LineItemRow[]; refunds: RefundRow[]; refundLines: RefundLineRow[] },
  key: Buffer = suppressionKey(),
) =>
  rpc<HistoryArrivalResult>("apply_history_arrivals", {
    p_shop_key: shopKey,
    p_orders: withOrderDigests(batch.orders, key, shopifyShopId),
    p_line_items: batch.lineItems,
    p_refunds: withRefundDigests(batch.refunds, key, shopifyShopId),
    p_refund_lines: batch.refundLines,
  });

export const writeCustomers = (shopKey: number, shopifyShopId: number, customers: CustomerRow[], key: Buffer = suppressionKey()) =>
  rpc<Record<string, number>>("ingest_customers", { p_shop_key: shopKey, p_customers: withCustomerDigests(customers, key, shopifyShopId) });

export const writeReturns = (shopKey: number, batch: { returns: ReturnRow[]; lineItems: ReturnLineItemRow[] }) =>
  rpc<Record<string, number>>("ingest_returns", { p_shop_key: shopKey, p_returns: batch.returns, p_return_line_items: batch.lineItems });

/** One batch of customers' first and last orders; call again with next_after until it is null. */
export const deriveCustomerFacts = (shopKey: number, after = 0, limit = 2_000) =>
  rpc<{ updated: number; next_after: number | null }>("derive_customer_order_facts", { p_shop_key: shopKey, p_after: after, p_limit: limit });

export interface Checkpoint {
  syncRunId: string | null;
  bulkOperationId: number | null;
  committedLine: number;
  watermark: string | null;
}

export const saveCheckpoint = (shopKey: number, domain: DataDomain, checkpoint: Checkpoint) =>
  rpc<{ outcome: "saved" | "stale" }>("save_sync_checkpoint", {
    p_shop_key: shopKey,
    p_domain: domain,
    p_sync_run: checkpoint.syncRunId,
    p_bulk_operation_id: checkpoint.bulkOperationId,
    p_committed_line: checkpoint.committedLine,
    p_watermark: checkpoint.watermark,
  });

/** The domain's last checkpoint, and when it was written (see checkpoint.ts for which may be resumed). */
export async function loadCheckpoint(shopKey: number, domain: DataDomain): Promise<(Checkpoint & { updatedAt: string | null }) | null> {
  const { data, error } = await supabaseAdmin
    .from("sync_checkpoints")
    .select("sync_run_id, bulk_operation_id, committed_line, watermark, updated_at")
    .eq("shop_key", shopKey)
    .eq("domain", domain)
    .maybeSingle();
  if (error) throw new IngestWriteError("sync_checkpoints", error.message);
  if (!data) return null;
  return {
    syncRunId: data.sync_run_id,
    bulkOperationId: data.bulk_operation_id === null ? null : Number(data.bulk_operation_id),
    committedLine: Number(data.committed_line),
    watermark: data.watermark,
    updatedAt: data.updated_at ?? null,
  };
}
