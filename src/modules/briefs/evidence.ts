import type { StoreInsights, StoreProduct } from "@/components/campaigns/types";

/**
 * Bounded brief evidence (Phase 1 task 9, DATA-01).
 *
 * A saved brief keeps only the store facts its readers use (the brief view,
 * the PDF payload, the copied text and the budget plan), not the whole store
 * snapshot, which is 2–4 MB and used to be copied into the campaign, every
 * version and the generation receipt. It stays under the same `storeInsights`
 * key, so every reader works unchanged.
 *
 * Kept: the store's identity, country and currency; five order aggregates
 * (bounded lists: at most five top locations and three peak days); the one
 * product the brief is for; the store-wide out-of-stock count; three
 * storefront analytics fields; and data-quality warnings.
 */
export const BRIEF_EVIDENCE_VERSION = 1;

const STORE_FIELDS = ["name", "domain", "myshopify_domain", "country", "currency", "currency_symbol"] as const;
const ORDER_FIELDS = ["average_order_value", "orders_last_30_days", "order_count", "peak_days", "top_locations"] as const;
const PRODUCT_FIELDS = [
  "id", "name", "handle", "price", "description", "tags", "in_stock", "order_count", "units_sold",
  "unit_cost", "unit_cost_currency", "unit_cost_coverage", "price_less_unit_cost",
] as const satisfies readonly (keyof StoreProduct)[];
const ANALYTICS_FIELDS = ["window_days", "conversion_rate", "recent_funnel"] as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** The named fields that are present; an absent field stays absent. */
function pick(source: unknown, fields: readonly string[]): Json | undefined {
  if (!isObject(source)) return undefined;
  const picked: Json = {};
  for (const field of fields) if (source[field] !== undefined) picked[field] = source[field];
  return picked;
}

export function isBoundedEvidence(value: unknown): boolean {
  return isObject(value) && value.evidence_version === BRIEF_EVIDENCE_VERSION;
}

/**
 * The evidence a brief for `productName` keeps from a store snapshot. Pure and
 * idempotent: already-bounded evidence is returned unchanged.
 */
export function boundBriefEvidence(snapshot: unknown, productName: string): StoreInsights | null {
  if (!isObject(snapshot)) return null;
  if (isBoundedEvidence(snapshot)) return snapshot as StoreInsights;

  const products = Array.isArray(snapshot.products) ? (snapshot.products as unknown[]) : undefined;
  const product = products?.find((p) => isObject(p) && p.name === productName);
  const prespend = isObject(snapshot.prespend) ? snapshot.prespend : undefined;
  const dataQuality = isObject(snapshot.data_quality) ? snapshot.data_quality : undefined;

  const evidence: Json = { evidence_version: BRIEF_EVIDENCE_VERSION };
  const store = pick(snapshot.store, STORE_FIELDS);
  if (store) evidence.store = store;
  const orders = pick(snapshot.orders, ORDER_FIELDS);
  if (orders) evidence.orders = orders;
  if (products) {
    evidence.products = product ? [pick(product, PRODUCT_FIELDS)] : [];
    evidence.catalog = { out_of_stock_count: products.filter((p) => isObject(p) && p.in_stock === false).length };
  }
  if (prespend) {
    const analytics = pick(prespend.analytics, ANALYTICS_FIELDS);
    evidence.prespend = analytics ? { analytics } : {};
  }
  if (dataQuality && dataQuality.warnings !== undefined) evidence.data_quality = { warnings: dataQuality.warnings };
  // Readers treat this as StoreInsights; they only reach the fields kept above.
  return evidence as StoreInsights;
}
