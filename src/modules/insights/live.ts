import "server-only";
import { syncShop } from "@/modules/ingestion/sync-repository";
import { buildCanonicalStoreData, type CanonicalInputsReport } from "./canonical";
import { fromStoredContext } from "./context";
import {
  importComplete, insightCatalog, insightMetaobjects, insightOrdersPage, insightProducts, insightQualityFacts, insightReturnEvidence, insightReturnSignals,
  insightShopContext, saveShopInsights,
} from "./repository";

/**
 * The worker side of the read path (Phase 2, task 11; Phase 3, task 5): builds
 * a shop's store snapshot from the database alone and stores it. Shop details
 * and the pre-spend datasets come from the stored shop context (0048), kept
 * current by its background sync (context-sync.ts); orders, products, images,
 * costs, references, inventory and return evidence from the mirror. Nothing
 * here reads Shopify.
 */
export type ShopInsightsReport =
  | ({ outcome: "saved"; bytes: number; contextSyncedAt: string } & CanonicalInputsReport)
  | { outcome: "not_ingestible" }
  | { outcome: "no_context" };

export async function computeShopInsights(shopDomain: string): Promise<ShopInsightsReport> {
  const shop = await syncShop(shopDomain);
  if (!shop) return { outcome: "not_ingestible" };
  const context = fromStoredContext(await insightShopContext(shop.shopKey));
  if (!context) return { outcome: "no_context" };
  const { data, inputs } = await buildCanonicalStoreData(shopDomain, {
    ordersPage: (before, limit) => insightOrdersPage(shop.shopKey, before, limit),
    catalog: (limit) => insightCatalog(shop.shopKey, limit),
    products: (ids) => insightProducts(shop.shopKey, ids),
    shop: async () => context.shop,
    intelligence: async () => ({ prespend: context.prespend, products: {}, returns: {}, warnings: context.warnings }),
    metaobjects: (ids) => insightMetaobjects(shop.shopKey, ids),
    returnEvidence: (ids, asOf) => insightReturnEvidence(shop.shopKey, ids, asOf),
    returnSignals: (ids) => insightReturnSignals(shop.shopKey, ids),
    returnsImported: () => importComplete(shop.shopId, ["returns"]),
    qualityFacts: (ids) => insightQualityFacts(shop.shopKey, ids),
    inventoryImported: () => importComplete(shop.shopId, ["inventory"]),
    ingestionComplete: () => importComplete(shop.shopId),
  });
  const saved = await saveShopInsights(shop.shopKey, data, inputs);
  return { outcome: "saved", bytes: saved.bytes, contextSyncedAt: context.syncedAt, ...inputs };
}
