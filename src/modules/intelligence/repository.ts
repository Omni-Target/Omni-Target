import "server-only";
import { insightShopContext } from "@/modules/insights/repository";
import { supabaseAdmin } from "@/platform/supabase";
import { normaliseChannelEvidence, type ChannelEvidence } from "./channels";
import { normaliseGeographyEvidence, type GeographyEvidence } from "./geography";
import { toShopMarketContext, type ShopMarketContext } from "./serviceability";

/**
 * The shop's markets, shipping zones and whether each was read, from the stored shop context (0048, refreshed by
 * shop-context-refresh). Null when the context has never been read: serviceability is then unknown, never negative.
 */
export async function shopMarketContext(shopKey: number): Promise<ShopMarketContext | null> {
  const stored = await insightShopContext(shopKey);
  if (!stored?.settings) return null;
  const capabilities = (stored.context?.capabilities as Record<string, unknown> | undefined) ?? null;
  const syncedAt = typeof stored.context?.synced_at === "string" ? stored.context.synced_at
    : typeof stored.settings.synced_at === "string" ? stored.settings.synced_at : null;
  return toShopMarketContext(stored.settings, capabilities, syncedAt);
}

/** Where at most 200 products' buyers are, at product, category and store scope (product_geography_evidence, 0061). */
export async function productGeographyEvidence(shopKey: number, productIds: number[], asOf: Date, windowDays = 365): Promise<GeographyEvidence> {
  const { data, error } = await supabaseAdmin.rpc("product_geography_evidence",
    { p_shop_key: shopKey, p_product_ids: productIds.slice(0, 200), p_as_of: asOf.toISOString(), p_window_days: windowDays });
  if (error) throw new Error(`product_geography_evidence failed: ${error.message}`);
  return normaliseGeographyEvidence(data);
}

/** Where at most 200 products' buyers came from, for the product and the store (product_channel_evidence, 0062). */
export async function productChannelEvidence(shopKey: number, productIds: number[], asOf: Date, windowDays = 365): Promise<ChannelEvidence> {
  const { data, error } = await supabaseAdmin.rpc("product_channel_evidence",
    { p_shop_key: shopKey, p_product_ids: productIds.slice(0, 200), p_as_of: asOf.toISOString(), p_window_days: windowDays });
  if (error) throw new Error(`product_channel_evidence failed: ${error.message}`);
  return normaliseChannelEvidence(data);
}
