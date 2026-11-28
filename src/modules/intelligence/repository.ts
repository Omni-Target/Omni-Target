import "server-only";
import { insightShopContext } from "@/modules/insights/repository";
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
