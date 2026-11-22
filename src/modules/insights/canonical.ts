import {
  computeStoreData, type ShopifyOrder, type ShopifyProduct, type ShopifyShop,
} from "@/lib/connectors/shopify";
import { productEnrichment, type ShopifyIntelligenceResult } from "@/lib/connectors/shopify-intelligence";
import type { StoreData } from "@/lib/store-data";

/**
 * The store snapshot from the canonical mirror (Phase 2, task 11).
 *
 * The dashboard, products page and briefs read the legacy StoreData shape. It
 * was built inside HTTP requests from a bounded Shopify REST sync; now a worker
 * builds it from the mirror with the same computation (computeStoreData), and
 * requests only read the stored result. Pure apart from the dependencies.
 *
 * Inputs, against the REST path:
 *  - orders: the most recent ORDER_LIMIT paid or partially refunded orders in
 *    the retained window (REST: 25,000 paid orders), dated by processed_at,
 *    Shopify's sales date (REST used created_at, wrong for imported orders);
 *  - products: the CATALOG_LIMIT most recently updated active products plus
 *    every product those orders reference, as REST did;
 *  - cost and catalog evidence for every one of those products, from the
 *    mirror (REST covered the first 400 active products, ING-03);
 *  - cities as normalised at ingest (country-aware, GEO-01), so no AI pass;
 *  - shop details, images and the pre-spend reads (markets, shipping,
 *    analytics, policies, returns) still come from Shopify, read by the worker.
 */
export const ORDER_LIMIT = 50_000;
export const ORDER_PAGE = 2_000;
export const CATALOG_LIMIT = 2_000;
export const PRODUCT_PAGE = 500;

export interface CanonicalOrder {
  id: number;
  processed_at: string;
  total_price: number | string;
  subtotal: number | string;
  financial_status: string | null;
  source_name: string | null;
  customer_id: number | null;
  customer_orders: number | null;
  customer_created_at: string | null;
  city: string | null;
  province_code: string | null;
  country_code: string | null;
  lines: Array<{ product_id: number | null; variant_id: number | null; quantity: number; price: number | string }>;
}
export interface CanonicalProduct {
  id: number;
  title: string;
  handle: string | null;
  description: string | null;
  tags: string[];
  product_type: string | null;
  vendor: string | null;
  status: string;
  created_at: string | null;
  variants: Array<{ id: number; title: string | null; price: number | string; inventory_quantity: number | null; unit_cost: number | string | null; unit_cost_currency: string | null }>;
  metafields: Array<{ namespace: string; key: string; type: string; value: string | null }>;
}

const money = (value: number | string | null | undefined) => String(Number(value ?? 0));

/** A mirrored order in the REST shape the computation reads. */
export function toShopifyOrder(order: CanonicalOrder): ShopifyOrder {
  return {
    id: order.id,
    total_price: money(order.total_price),
    subtotal_price: money(order.subtotal),
    created_at: order.processed_at,
    customer: order.customer_id
      ? { id: order.customer_id, ...(order.customer_orders !== null ? { orders_count: order.customer_orders } : {}), ...(order.customer_created_at ? { created_at: order.customer_created_at } : {}) }
      : undefined,
    shipping_address: order.city || order.country_code || order.province_code
      ? { city: order.city ?? undefined, province_code: order.province_code ?? undefined, country_code: order.country_code ?? undefined }
      : undefined,
    financial_status: order.financial_status ?? "paid",
    source_name: order.source_name ?? "",
    referring_site: null,
    landing_site: null,
    line_items: order.lines
      .filter((line) => line.product_id !== null)
      .map((line) => ({ product_id: line.product_id as number, ...(line.variant_id ? { variant_id: line.variant_id } : {}), quantity: line.quantity, price: money(line.price) })),
  };
}

/** A mirrored product in the REST shape the computation reads. */
export function toShopifyProduct(product: CanonicalProduct, imageUrl?: string | null): ShopifyProduct {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle ?? "",
    body_html: product.description ?? "",
    tags: product.tags.join(", "),
    product_type: product.product_type ?? "",
    vendor: product.vendor ?? "",
    created_at: product.created_at ?? "",
    variants: product.variants.map((variant) => ({
      id: variant.id, title: variant.title ?? "", price: money(variant.price), inventory_quantity: variant.inventory_quantity ?? 0,
    })),
    images: imageUrl ? [{ src: imageUrl }] : [],
  };
}

/** Cost and catalog evidence for every product, as the live enrichment computes it. */
export function canonicalEnrichment(products: CanonicalProduct[]): ShopifyIntelligenceResult["products"] {
  return Object.fromEntries(products.map((product) => [
    String(product.id),
    productEnrichment(
      product.variants.map((v) => (v.unit_cost === null || !v.unit_cost_currency ? null : { amount: v.unit_cost, currencyCode: v.unit_cost_currency })),
      product.metafields.flatMap((m) => (m.value === null ? [] : [{ namespace: m.namespace, key: m.key, type: m.type, value: m.value }])),
    ),
  ]));
}

export interface CanonicalInsightsDeps {
  ordersPage: (before: { at: string; id: number } | null, limit: number) => Promise<CanonicalOrder[]>;
  catalog: (limit: number) => Promise<{ active: number; ids: number[] }>;
  products: (ids: number[]) => Promise<CanonicalProduct[]>;
  /** Read from Shopify by the worker. */
  shop: () => Promise<ShopifyShop>;
  intelligence: () => Promise<ShopifyIntelligenceResult>;
  images: (productIds: number[]) => Promise<Map<number, string>>;
  ingestionComplete: () => Promise<boolean>;
  now?: () => number;
}

export interface CanonicalInputsReport {
  source: "canonical";
  orders: number;
  ordersTruncated: boolean;
  products: number;
  activeProducts: number;
  productsWithImages: number;
  durationMs: number;
}

export async function buildCanonicalStoreData(
  shopDomain: string,
  deps: CanonicalInsightsDeps,
  { orderLimit = ORDER_LIMIT, catalogLimit = CATALOG_LIMIT } = {},
): Promise<{ data: StoreData; inputs: CanonicalInputsReport }> {
  const now = deps.now ?? Date.now;
  const started = now();
  // Shopify reads run alongside the mirror reads.
  const live = Promise.all([deps.shop(), deps.intelligence(), deps.ingestionComplete()]);

  const orders: CanonicalOrder[] = [];
  let ordersTruncated = false;
  let before: { at: string; id: number } | null = null;
  for (;;) {
    const want = Math.min(ORDER_PAGE, orderLimit - orders.length);
    const page = await deps.ordersPage(before, want);
    orders.push(...page);
    if (page.length < want) break;
    const last = page[page.length - 1];
    before = { at: last.processed_at, id: last.id };
    if (orders.length >= orderLimit) {
      ordersTruncated = (await deps.ordersPage(before, 1)).length > 0;
      break;
    }
  }

  const catalog = await deps.catalog(catalogLimit);
  const ids = [...new Set([...catalog.ids, ...orders.flatMap((o) => o.lines.map((l) => l.product_id).filter((id): id is number => id !== null))])];
  const products: CanonicalProduct[] = [];
  for (let i = 0; i < ids.length; i += PRODUCT_PAGE) products.push(...(await deps.products(ids.slice(i, i + PRODUCT_PAGE))));
  const images = await deps.images(products.map((p) => p.id));

  const [shop, intelligence, ingestionComplete] = await live;
  const data = await computeStoreData({
    shopDomain,
    userId: null,
    shop,
    orders: orders.map(toShopifyOrder),
    ordersTruncated,
    ingestionComplete,
    intelligence: { ...intelligence, products: canonicalEnrichment(products) },
    totalCatalogProductsCount: catalog.active || undefined,
    rawProducts: products.map((p) => toShopifyProduct(p, images.get(p.id))),
    productsTruncated: catalog.active > catalogLimit,
  }, { consolidateLocations: async () => ({}) });

  return {
    data,
    inputs: {
      source: "canonical", orders: orders.length, ordersTruncated, products: products.length, activeProducts: catalog.active,
      productsWithImages: images.size, durationMs: now() - started,
    },
  };
}
