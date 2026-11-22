import "server-only";
import type { ImportDomain } from "@/modules/capacity/projection";
import { supabaseAdmin } from "@/platform/supabase";

/** The incremental sync's inbox and watermarks (migration 0040). One RPC per call, as service_role. */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}

export interface InboxEvent {
  webhook_id: string;
  event_id?: string | null;
  topic: string;
  triggered_at?: string | null;
  payload: Record<string, string | number | null>;
}

export const recordSyncEvents = (shopDomain: string, events: InboxEvent[]) =>
  rpc<{ outcome: "recorded" | "ignored"; recorded: number; shop_key?: number }>("record_sync_events", { p_shop_domain: shopDomain, p_events: events });

export interface ClaimedEvent {
  id: string;
  topic: string;
  payload: Record<string, unknown> | null;
  triggered_at: string | null;
  attempts: number;
}

export const claimSyncEvents = (shopKey: number, runId: string, limit = 100) =>
  rpc<ClaimedEvent[]>("claim_sync_events", { p_shop_key: shopKey, p_run_id: runId, p_limit: limit, p_stale_seconds: 900 });

export const finishSyncEvents = (runId: string, processed: string[], failed: Array<{ id: string; error: string }>) =>
  rpc<{ processed: number; failed: number; dead: number }>("finish_sync_events", {
    p_run_id: runId, p_processed: processed, p_failed: failed, p_max_attempts: 8,
  });

export const syncShopsDue = (limit = 100) =>
  rpc<Array<{ shop_key: number; shop_domain: string; due: number; oldest: string | null; dead: number }>>("sync_shops_due", { p_limit: limit });

export const deleteSyncedRecords = (shopKey: number, kind: "order" | "product" | "customer", ids: number[]) =>
  rpc<{ deleted: number }>("delete_synced_records", { p_shop_key: shopKey, p_kind: kind, p_ids: ids });

export const saveSyncWatermark = (shopKey: number, domain: "orders" | "catalog" | "customers", watermark: string) =>
  rpc<{ watermark: string }>("save_sync_watermark", { p_shop_key: shopKey, p_domain: domain, p_watermark: watermark });

export async function loadSyncWatermark(shopKey: number, domain: "orders" | "catalog" | "customers"): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("sync_checkpoints").select("watermark").eq("shop_key", shopKey).eq("domain", domain).maybeSingle();
  if (error) throw new Error(`sync_checkpoints read failed: ${error.message}`);
  return (data?.watermark as string | null | undefined) ?? null;
}

/** The shop, if it is open for ingestion. */
export async function syncShop(shopDomain: string): Promise<{ shopKey: number; shopifyShopId: number; shopId: string } | null> {
  const { data, error } = await supabaseAdmin.from("shops").select("id, shop_key, shopify_shop_id").eq("myshopify_domain", shopDomain).maybeSingle();
  if (error) throw new Error(`shops read failed: ${error.message}`);
  if (!data?.shopify_shop_id) return null;
  const { data: open, error: openError } = await supabaseAdmin.rpc("shop_ingestion_open", { p_shop_key: data.shop_key });
  if (openError) throw new Error(`shop_ingestion_open failed: ${openError.message}`);
  return open ? { shopKey: Number(data.shop_key), shopifyShopId: Number(data.shopify_shop_id), shopId: String(data.id) } : null;
}

/** When the shop's latest finished import covering this domain started: where its reconcile first looks from. */
export async function lastImportStart(shopId: string, domain: ImportDomain): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("shop_imports").select("started_at, domains")
    .eq("shop_id", shopId).in("status", ["succeeded", "partial"]).order("started_at", { ascending: false }).limit(20);
  if (error) throw new Error(`shop_imports read failed: ${error.message}`);
  const covering = (data ?? []).find((row) => !row.domains || (row.domains as string[]).includes(domain));
  return (covering?.started_at as string | undefined) ?? null;
}

/** Shops with a finished import, for the daily reconcile (each is checked for ingestion when it runs). */
export async function reconcilableShops(): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("shop_imports").select("shops!inner(myshopify_domain)").in("status", ["succeeded", "partial"]).limit(5000);
  if (error) throw new Error(`shop_imports read failed: ${error.message}`);
  const domains = (data ?? []).map((row) => (row as unknown as { shops: { myshopify_domain: string } }).shops.myshopify_domain);
  return [...new Set(domains)].sort();
}
