import "server-only";
import { shopifyGraphql } from "@/lib/connectors/shopify-graphql";
import { fetchShopifyPrespendIntelligence } from "@/lib/connectors/shopify-intelligence";
import type { ShopifyShop } from "@/lib/connectors/shopify";
import { getShopifyAccessForShop } from "@/modules/credentials/shopify";
import { syncShop } from "@/modules/ingestion/sync-repository";
import { buildCanonicalStoreData, type CanonicalInputsReport } from "./canonical";
import { importComplete, insightCatalog, insightOrdersPage, insightProducts, saveShopInsights } from "./repository";

/**
 * The worker side of the read path (Phase 2, task 11): builds a shop's store
 * snapshot from the mirror and stores it. The few reads that still go to
 * Shopify (shop details, product images, the pre-spend datasets) are bounded
 * GraphQL calls made here, never in a request.
 */
type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const SHOP = `{ shop { name myshopifyDomain primaryDomain { host } currencyCode billingAddress { countryCodeV2 } currencyFormats { moneyFormat } } }`;
const IMAGES = `query ProductImages($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id featuredMedia { preview { image { url } } } } } }`;
const IMAGE_PAGE = 100;

async function fetchShop(gql: Gql, domain: string): Promise<ShopifyShop> {
  const { shop } = await gql<{ shop: { name: string; myshopifyDomain: string; primaryDomain?: { host?: string } | null; currencyCode: string;
    billingAddress?: { countryCodeV2?: string | null } | null; currencyFormats?: { moneyFormat?: string } | null } }>(SHOP);
  return {
    name: shop.name, domain: shop.primaryDomain?.host || domain, myshopify_domain: shop.myshopifyDomain, currency: shop.currencyCode,
    country_code: shop.billingAddress?.countryCodeV2 ?? "", ...(shop.currencyFormats?.moneyFormat ? { money_format: shop.currencyFormats.moneyFormat } : {}),
  };
}

async function fetchImages(gql: Gql, ids: number[]): Promise<Map<number, string>> {
  const images = new Map<number, string>();
  for (let i = 0; i < ids.length; i += IMAGE_PAGE) {
    const slice = ids.slice(i, i + IMAGE_PAGE);
    const { nodes } = await gql<{ nodes: Array<{ id?: string; featuredMedia?: { preview?: { image?: { url?: string } | null } | null } | null } | null> }>(
      IMAGES, { ids: slice.map((id) => `gid://shopify/Product/${id}`) });
    nodes.forEach((node, index) => {
      const url = node?.featuredMedia?.preview?.image?.url;
      if (url) images.set(slice[index], url);
    });
  }
  return images;
}

export type ShopInsightsReport =
  | ({ outcome: "saved"; bytes: number } & CanonicalInputsReport)
  | { outcome: "not_ingestible" }
  | { outcome: "no_access"; status: string };

export async function computeShopInsights(shopDomain: string): Promise<ShopInsightsReport> {
  const shop = await syncShop(shopDomain);
  if (!shop) return { outcome: "not_ingestible" };
  const access = await getShopifyAccessForShop(shopDomain);
  if (access.status !== "ok") return { outcome: "no_access", status: access.status };
  const gql: Gql = (query, variables) => shopifyGraphql(shopDomain, access.accessToken, query, variables);
  const { data, inputs } = await buildCanonicalStoreData(shopDomain, {
    ordersPage: (before, limit) => insightOrdersPage(shop.shopKey, before, limit),
    catalog: (limit) => insightCatalog(shop.shopKey, limit),
    products: (ids) => insightProducts(shop.shopKey, ids),
    shop: () => fetchShop(gql, shopDomain),
    intelligence: () => fetchShopifyPrespendIntelligence(shopDomain, access.accessToken),
    images: (ids) => fetchImages(gql, ids),
    ingestionComplete: () => importComplete(shop.shopId),
  });
  const saved = await saveShopInsights(shop.shopKey, data, inputs);
  return { outcome: "saved", bytes: saved.bytes, ...inputs };
}
