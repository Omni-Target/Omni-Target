import {
  computeStoreData, type ShopifyOrder, type ShopifyProduct, type ShopifyShop,
} from "@/lib/connectors/shopify";
import { productEnrichment, type ShopifyIntelligenceResult } from "@/lib/connectors/shopify-intelligence";
import type { StoreCatalogClaim, StoreData, StoreProductReturnEvidence, StoreReturnSignal } from "@/lib/store-data";
import { metaobjectReferenceIds } from "@/modules/ingestion/mappers";

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
 *  - product images from the mirror (Phase 3, tasks 2 and 5): a product not yet
 *    read with Phase 3's fields (fields_version null) has none until it is;
 *  - catalog claims from product and variant metafields, with referenced
 *    metaobjects resolved from the mirror (Phase 3, task 2);
 *  - shop details and the pre-spend datasets (markets, shipping, analytics,
 *    policies, discounts, marketing) from the stored shop context (task 5),
 *    return evidence and signals from the mirror (task 4): nothing is read
 *    from Shopify here.
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
  variants: Array<{
    id: number; title: string | null; price: number | string; inventory_quantity: number | null; unit_cost: number | string | null; unit_cost_currency: string | null;
    /** 0046: tracking, policy, and the sum available at active locations that fulfil online orders (null: no level stored). */
    tracked?: boolean | null; inventory_policy?: string | null; available_online?: number | string | null;
  }>;
  /** Product metafields, and (0044) its variants' (owner "variant"), each with its definition's name when the shop defines one. */
  metafields: Array<{ owner?: "product" | "variant"; namespace: string; key: string; type: string; value: string | null; name?: string | null }>;
  /** The featured image (0044); null when there is none, or when the row predates 0044 (fields_version null). */
  image_url?: string | null;
  fields_version?: number | null;
}
export interface CanonicalMetaobject {
  id: number;
  type: string;
  display_name: string | null;
  fields: Record<string, string>;
  definition_name?: string | null;
}
const MAX_VARIANT_VALUES = 10;

/** product_return_evidence's rows (0047). */
export interface MirrorReturnEvidence {
  product_id: number; eligible_units: number; processed_return_units: number | null; refunded_units: number | null;
  processed_return_rate: number | string | null; primary_reason: string | null; risk: StoreProductReturnEvidence["risk"]; complete: boolean;
}
/** product_return_signals's rows (0047). */
export interface MirrorReturnSignal extends StoreReturnSignal { product_id: number }

/** Mirror evidence in the snapshot's shape. */
export function toReturnEvidence(rows: MirrorReturnEvidence[]): Record<string, StoreProductReturnEvidence> {
  return Object.fromEntries(rows.map((row) => [String(row.product_id), {
    eligible_units: Number(row.eligible_units),
    processed_return_units: row.processed_return_units === null ? null : Number(row.processed_return_units),
    refunded_units: row.refunded_units === null ? null : Number(row.refunded_units),
    processed_return_rate: row.processed_return_rate === null ? null : Number(row.processed_return_rate),
    ...(row.primary_reason ? { primary_reason: row.primary_reason } : {}),
    risk: row.risk,
    window_days: 365,
    maturity_days: 60,
  } satisfies StoreProductReturnEvidence]));
}

const money = (value: number | string | null | undefined) => String(Number(value ?? 0));
const regions = new Intl.DisplayNames(["en"], { type: "region" });
/** The country's name, as Shopify REST gives it alongside the code ("Nigeria" for NG). */
const countryName = (code: string | null) => {
  if (!code) return undefined;
  try {
    return regions.of(code) ?? undefined;
  } catch {
    return undefined;
  }
};

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
      ? { city: order.city ?? undefined, province_code: order.province_code ?? undefined, country_code: order.country_code ?? undefined, country: countryName(order.country_code) }
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
      id: variant.id, title: variant.title ?? "", price: money(variant.price),
      // What the shop can sell online: the online locations' stock when levels are stored (task 3), else Shopify's variant count.
      inventory_quantity: variant.available_online !== null && variant.available_online !== undefined ? Number(variant.available_online) : (variant.inventory_quantity ?? 0),
      ...(variant.tracked === true ? { inventory_management: "shopify" } : variant.tracked === false ? { inventory_management: null } : {}),
      ...(variant.inventory_policy ? { inventory_policy: variant.inventory_policy } : {}),
    })),
    images: imageUrl ? [{ src: imageUrl }] : [],
  };
}

/** Every metaobject the products' metafields reference. */
export const referencedMetaobjectIds = (products: CanonicalProduct[]): number[] =>
  [...new Set(products.flatMap((p) => p.metafields.flatMap((m) => metaobjectReferenceIds(m.type, m.value))))];

/**
 * Cost and catalog evidence for every product, as the live enrichment computes it, plus what Phase 3 reads:
 * a reference metafield gives a claim per field of each metaobject it references (single or list, as the
 * live path did for single references; Shopify IDs are not claims), and variant metafields give claims of
 * their own, one per distinct value.
 */
export function canonicalEnrichment(products: CanonicalProduct[], metaobjects: ReadonlyMap<number, CanonicalMetaobject> = new Map()): ShopifyIntelligenceResult["products"] {
  return Object.fromEntries(products.map((product) => {
    const productFields = product.metafields.filter((m) => (m.owner ?? "product") === "product" && m.value !== null).flatMap((m) => {
      const ids = metaobjectReferenceIds(m.type, m.value);
      if (!ids.length) return [{ namespace: m.namespace, key: m.key, type: m.type, value: m.value as string }];
      return ids.flatMap((id) => {
        const target = metaobjects.get(id);
        if (!target) return [];
        const fields = Object.entries(target.fields).filter(([, value]) => !value.startsWith("gid://")).map(([key, value]) => ({ key, value }));
        return [{ namespace: m.namespace, key: m.key, type: "metaobject_reference", value: `gid://shopify/Metaobject/${id}`, reference: { type: target.type, fields } }];
      });
    });
    const enrichment = productEnrichment(
      product.variants.map((v) => (v.unit_cost === null || !v.unit_cost_currency ? null : { amount: v.unit_cost, currencyCode: v.unit_cost_currency })),
      productFields,
    );
    const variantValues = new Map<string, Set<string>>();
    for (const m of product.metafields) {
      if (m.owner !== "variant" || m.value === null || m.value.length > 1_000 || m.type.includes("reference")) continue;
      const key = `${m.namespace}.${m.key}`;
      const values = variantValues.get(key) ?? new Set<string>();
      if (values.size < MAX_VARIANT_VALUES) values.add(m.value);
      variantValues.set(key, values);
    }
    const variantClaims: StoreCatalogClaim[] = [...variantValues].flatMap(([key, values]) => [...values].map((value) => ({ key, value, source: "variant_metafield" as const })));
    return [String(product.id), { ...enrichment, claims: [...enrichment.claims, ...variantClaims] }];
  }));
}

export interface CanonicalInsightsDeps {
  ordersPage: (before: { at: string; id: number } | null, limit: number) => Promise<CanonicalOrder[]>;
  catalog: (limit: number) => Promise<{ active: number; ids: number[] }>;
  products: (ids: number[]) => Promise<CanonicalProduct[]>;
  /** Read from Shopify by the worker. */
  shop: () => Promise<ShopifyShop>;
  intelligence: () => Promise<ShopifyIntelligenceResult>;
  /** Stored metaobjects by ID (0044). */
  metaobjects: (ids: number[]) => Promise<CanonicalMetaobject[]>;
  /** Return evidence and return signals from the mirror (0047), at most 500 products a call. */
  returnEvidence: (productIds: number[], asOf: string) => Promise<MirrorReturnEvidence[]>;
  returnSignals: (productIds: number[]) => Promise<MirrorReturnSignal[]>;
  /** Whether the shop's returns were imported: without them, return evidence is unavailable, not zero. */
  returnsImported: () => Promise<boolean>;
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
  const live = Promise.all([deps.shop(), deps.intelligence(), deps.ingestionComplete(), deps.returnsImported()]);

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
  // Images from the mirror only (task 5): a product not yet read with Phase 3's fields has none until it is.
  const images = new Map<number, string>();
  for (const p of products) if (p.image_url) images.set(p.id, p.image_url);
  const metaobjects = new Map<number, CanonicalMetaobject>();
  const referenced = referencedMetaobjectIds(products);
  for (let i = 0; i < referenced.length; i += PRODUCT_PAGE) for (const o of await deps.metaobjects(referenced.slice(i, i + PRODUCT_PAGE))) metaobjects.set(o.id, o);

  const [shop, intelligence, ingestionComplete, returnsImported] = await live;
  // Return evidence and signals from the mirror (task 4), in place of the live fetch.
  const asOf = new Date(now()).toISOString();
  const evidenceRows: MirrorReturnEvidence[] = [];
  const signalRows: MirrorReturnSignal[] = [];
  for (let i = 0; i < products.length; i += PRODUCT_PAGE) {
    const page = products.slice(i, i + PRODUCT_PAGE).map((p) => p.id);
    if (returnsImported) evidenceRows.push(...(await deps.returnEvidence(page, asOf)));
    signalRows.push(...(await deps.returnSignals(page)));
  }
  const returnCapability = returnsImported
    ? { status: "available" as const, required_scopes: ["read_orders", "read_returns"], detail: "From the stored orders, refunds and returns" }
    : { status: "missing_scope" as const, required_scopes: ["read_orders", "read_returns"], detail: "Returns not imported" };
  const data = await computeStoreData({
    shopDomain,
    userId: null,
    shop,
    orders: orders.map(toShopifyOrder),
    ordersTruncated,
    ingestionComplete,
    intelligence: {
      ...intelligence,
      prespend: { ...intelligence.prespend, capabilities: { ...intelligence.prespend.capabilities, return_evidence: returnCapability } },
      products: canonicalEnrichment(products, metaobjects),
      returns: returnsImported ? toReturnEvidence(evidenceRows) : {},
    },
    totalCatalogProductsCount: catalog.active || undefined,
    rawProducts: products.map((p) => toShopifyProduct(p, images.get(p.id))),
    productsTruncated: catalog.active > catalogLimit,
  }, { consolidateLocations: async () => ({}) });

  const signals = new Map<string, StoreReturnSignal[]>();
  for (const { product_id, ...signal } of signalRows) signals.set(String(product_id), [...(signals.get(String(product_id)) ?? []), signal]);
  for (const product of data.products) {
    const found = signals.get(String(product.id));
    if (found) product.return_signals = found;
  }

  return {
    data,
    inputs: {
      source: "canonical", orders: orders.length, ordersTruncated, products: products.length, activeProducts: catalog.active,
      productsWithImages: images.size, durationMs: now() - started,
    },
  };
}
