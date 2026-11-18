import "server-only";
import { suppressionKey } from "@/modules/compliance/suppression";
import { supabaseAdmin } from "@/platform/supabase";
import { withCustomerDigests, withOrderDigests } from "./digests";
import type { DataDomain } from "./access";
import type {
  CustomerRow, InventoryLevelRow, LineItemRow, LocationRow, MetafieldRow, OrderRow, ProductRow, RefundRow,
  ReturnLineItemRow, ReturnRow, VariantRow,
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

export const writeInventory = (shopKey: number, batch: { locations: LocationRow[]; levels: InventoryLevelRow[] }) =>
  rpc<Record<string, number>>("ingest_inventory", { p_shop_key: shopKey, p_locations: batch.locations, p_levels: batch.levels });

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

export async function loadCheckpoint(shopKey: number, domain: DataDomain): Promise<Checkpoint | null> {
  const { data, error } = await supabaseAdmin
    .from("sync_checkpoints")
    .select("sync_run_id, bulk_operation_id, committed_line, watermark")
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
  };
}
