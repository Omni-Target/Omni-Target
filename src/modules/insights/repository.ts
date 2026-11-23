import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import type { StoreData } from "@/lib/store-data";
import type { CanonicalInputsReport, CanonicalMetaobject, CanonicalOrder, CanonicalProduct, MirrorReturnEvidence, MirrorReturnSignal } from "./canonical";
import type { StoredShopContext } from "./context";
import type { ProductQualityFacts } from "@/modules/quality/rules";

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

export const insightMetaobjects = (shopKey: number, ids: number[]) =>
  rpc<CanonicalMetaobject[]>("insight_metaobjects", { p_shop_key: shopKey, p_ids: ids });

export const insightReturnEvidence = (shopKey: number, ids: number[], asOf: string) =>
  rpc<MirrorReturnEvidence[]>("product_return_evidence", { p_shop_key: shopKey, p_product_ids: ids, p_as_of: asOf });

export const insightQualityFacts = (shopKey: number, ids: number[]) =>
  rpc<ProductQualityFacts[]>("product_quality_facts", { p_shop_key: shopKey, p_product_ids: ids });

export const insightReturnSignals = (shopKey: number, ids: number[]) =>
  rpc<MirrorReturnSignal[]>("product_return_signals", { p_shop_key: shopKey, p_product_ids: ids });

/** Shop context (0048): stored by the background sync, read by the insights worker. */
export const saveShopContext = (shopKey: number, settings: Record<string, unknown>, context: Record<string, unknown>) =>
  rpc<{ saved: boolean }>("save_shop_context", { p_shop_key: shopKey, p_settings: settings, p_context: context });

export const insightShopContext = (shopKey: number) => rpc<StoredShopContext>("insight_shop_context", { p_shop_key: shopKey });

export async function shopContextSyncedAt(shopKey: number): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("shop_context").select("synced_at").eq("shop_key", shopKey).maybeSingle();
  if (error) throw new Error(`shop_context read failed: ${error.message}`);
  return data ? String(data.synced_at) : null;
}

export const shopsContextDue = (maxAgeSeconds: number, limit: number) =>
  rpc<Array<{ shop_domain: string; synced_at: string | null }>>("shops_context_due", { p_max_age_seconds: maxAgeSeconds, p_limit: limit });

/** The storefront logo the context sync stored for a shop, if any. */
export async function storedShopLogo(shopDomain: string): Promise<string | null> {
  const { data: shop, error } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", shopDomain).maybeSingle();
  if (error) throw new Error(`shops read failed: ${error.message}`);
  if (!shop) return null;
  const { data, error: settingsError } = await supabaseAdmin.from("shop_settings").select("logo_url").eq("shop_key", shop.shop_key).maybeSingle();
  if (settingsError) throw new Error(`shop_settings read failed: ${settingsError.message}`);
  return (data?.logo_url as string | null | undefined) ?? null;
}

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
export async function importComplete(shopId: string, domains: string[] = ["orders", "catalog"]): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("shop_imports").select("coverage").eq("shop_id", shopId)
    .in("status", ["succeeded", "partial"]).order("finished_at", { ascending: false }).limit(50);
  if (error) throw new Error(`shop_imports read failed: ${error.message}`);
  return importsComplete((data ?? []).map((row) => row.coverage), domains);
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
