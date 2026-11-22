import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import type { StoreData } from "@/lib/store-data";
import type { CanonicalInputsReport, CanonicalOrder, CanonicalProduct } from "./canonical";

/** The mirror reads and the stored snapshot of the read path (migration 0043). */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}

export const insightOrdersPage = (shopKey: number, before: { at: string; id: number } | null, limit: number) =>
  rpc<CanonicalOrder[]>("insight_orders_page", { p_shop_key: shopKey, p_before: before?.at ?? null, p_before_id: before?.id ?? null, p_limit: limit });

export const insightCatalog = (shopKey: number, limit: number) =>
  rpc<{ active: number; ids: number[] }>("insight_catalog", { p_shop_key: shopKey, p_limit: limit });

export const insightProducts = (shopKey: number, ids: number[]) =>
  rpc<CanonicalProduct[]>("insight_products", { p_shop_key: shopKey, p_ids: ids });

export const saveShopInsights = (shopKey: number, data: StoreData, inputs: CanonicalInputsReport) =>
  rpc<{ saved: boolean; bytes: number }>("save_shop_insights", {
    p_shop_key: shopKey, p_schema_version: data.data_quality?.schema_version ?? 9, p_data: data, p_inputs: inputs,
  });

export interface StoredInsights {
  data: StoreData;
  computedAt: string;
  schemaVersion: number;
}
export async function readShopInsights(shopKey: number): Promise<StoredInsights | null> {
  const { data, error } = await supabaseAdmin.from("shop_insights").select("data, computed_at, schema_version").eq("shop_key", shopKey).maybeSingle();
  if (error) throw new Error(`shop_insights read failed: ${error.message}`);
  return data ? { data: data.data as StoreData, computedAt: String(data.computed_at), schemaVersion: Number(data.schema_version) } : null;
}

export const shopsInsightsDue = (maxAgeSeconds: number, limit: number) =>
  rpc<Array<{ shop_domain: string; computed_at: string | null }>>("shops_insights_due", { p_max_age_seconds: maxAgeSeconds, p_limit: limit });

/**
 * Whether the shop's orders and catalog were each completed by the last finished import that covered
 * them: a scoped import (0039) covers some domains, and leaves the others as an earlier import left them.
 */
export async function importComplete(shopId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("shop_imports").select("coverage").eq("shop_id", shopId)
    .in("status", ["succeeded", "partial"]).order("finished_at", { ascending: false }).limit(50);
  if (error) throw new Error(`shop_imports read failed: ${error.message}`);
  return importsComplete((data ?? []).map((row) => row.coverage), ["orders", "catalog"]);
}

/** Pure: newest first, the first coverage that imported each domain decides it (a scoped import records the rest as skipped). */
export function importsComplete(coverages: unknown[], domains: string[]): boolean {
  return domains.every((domain) => {
    const latest = coverages
      .map((c) => (c as { domains?: Record<string, { status?: string }> } | null)?.domains?.[domain])
      .find((entry) => entry && entry.status !== "skipped");
    return latest?.status === "succeeded";
  });
}
