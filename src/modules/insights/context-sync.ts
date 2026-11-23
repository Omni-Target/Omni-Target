import "server-only";
import { shopifyGraphql } from "@/lib/connectors/shopify-graphql";
import { fetchShopifyPrespendIntelligence } from "@/lib/connectors/shopify-intelligence";
import { fetchShopifyStoreLogo } from "@/lib/shopify-store-logo";
import { getShopifyAccessForShop } from "@/modules/credentials/shopify";
import { syncShop } from "@/modules/ingestion/sync-repository";
import { createLogger } from "@/platform/logger";
import { toContextRows, type ShopDetails } from "./context";
import { saveShopContext, shopContextSyncedAt } from "./repository";

/**
 * The background side of shop context (Phase 3, task 5): reads shop details
 * and the pre-spend datasets from Shopify and stores them (migration 0048).
 * Run after imports, daily (shop-context-refresh), and by the insights worker
 * when the stored context is missing or more than a day old. Never in a
 * request: pages read only what this stored.
 */
const log = createLogger({ module: "shop-context" });

// The shop's own address (as REST's shop.json gave the country), not its billing address.
const SHOP = `{ shop { name myshopifyDomain primaryDomain { host } currencyCode currencyFormats { moneyFormat } ianaTimezone
  shopAddress { countryCodeV2 provinceCode } plan { publicDisplayName shopifyPlus partnerDevelopment } weightUnit taxesIncluded } }`;

type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export async function fetchShopDetails(gql: Gql): Promise<ShopDetails> {
  const { shop } = await gql<{ shop: {
    name: string; myshopifyDomain: string; primaryDomain?: { host?: string } | null; currencyCode: string; currencyFormats?: { moneyFormat?: string } | null;
    ianaTimezone?: string | null; shopAddress?: { countryCodeV2?: string | null; provinceCode?: string | null } | null;
    plan?: { publicDisplayName?: string | null; shopifyPlus?: boolean | null; partnerDevelopment?: boolean | null } | null;
    weightUnit?: string | null; taxesIncluded?: boolean | null;
  } }>(SHOP);
  return {
    name: shop.name, primaryDomain: shop.primaryDomain?.host ?? null, myshopifyDomain: shop.myshopifyDomain, currency: shop.currencyCode,
    moneyFormat: shop.currencyFormats?.moneyFormat ?? null, timezone: shop.ianaTimezone ?? null,
    countryCode: shop.shopAddress?.countryCodeV2 ?? null, provinceCode: shop.shopAddress?.provinceCode ?? null,
    plan: { displayName: shop.plan?.publicDisplayName ?? null, shopifyPlus: shop.plan?.shopifyPlus ?? null, partnerDevelopment: shop.plan?.partnerDevelopment ?? null },
    weightUnit: shop.weightUnit ?? null, taxesIncluded: shop.taxesIncluded ?? null,
  };
}

export type ShopContextReport =
  | { outcome: "saved"; datasets: Record<string, string>; logo: boolean; ms: number }
  | { outcome: "not_ingestible" }
  | { outcome: "no_access"; status: string };

export async function syncShopContext(shopDomain: string, now: () => number = Date.now): Promise<ShopContextReport> {
  const started = now();
  const shop = await syncShop(shopDomain);
  if (!shop) return { outcome: "not_ingestible" };
  const access = await getShopifyAccessForShop(shopDomain);
  if (access.status !== "ok") return { outcome: "no_access", status: access.status };
  const gql: Gql = (query, variables) => shopifyGraphql(shopDomain, access.accessToken, query, variables);
  const [details, intelligence] = await Promise.all([
    fetchShopDetails(gql),
    fetchShopifyPrespendIntelligence(shopDomain, access.accessToken, { returnEvidence: false, productEvidence: false, locations: false }),
  ]);
  // The storefront logo is optional: a failure keeps the last one stored.
  const logo = await fetchShopifyStoreLogo(shopDomain, details.primaryDomain).catch((error) => {
    log.warn("Store logo not read", { shop: shopDomain }, error);
    return null;
  });
  const rows = toContextRows(details, intelligence.prespend, intelligence.warnings, logo);
  await saveShopContext(shop.shopKey, rows.settings, rows.context);
  return {
    outcome: "saved", logo: Boolean(logo), ms: now() - started,
    datasets: Object.fromEntries(Object.entries(intelligence.prespend.capabilities).map(([name, c]) => [name, c.status])),
  };
}

/** Syncs the shop's context when it is missing or older than maxAgeMs; never fatal to the caller. */
export async function ensureShopContext(shopDomain: string, shopKey: number, maxAgeMs = 24 * 3_600_000): Promise<ShopContextReport | { outcome: "fresh" } | { outcome: "failed"; error: string }> {
  const syncedAt = await shopContextSyncedAt(shopKey);
  if (syncedAt && Date.now() - Date.parse(syncedAt) < maxAgeMs) return { outcome: "fresh" };
  try {
    return await syncShopContext(shopDomain);
  } catch (error) {
    log.warn("Shop context not synced", { shop: shopDomain }, error);
    return { outcome: "failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" };
  }
}
