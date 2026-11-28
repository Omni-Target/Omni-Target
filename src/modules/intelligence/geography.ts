import { assessServiceability, type MarketServiceability, type ShopMarketContext } from "./serviceability";

/**
 * Product geography (Phase 5, task 4; architecture/phase-5-intelligence.md, "Product geography"). Where a product's
 * buyers are, from paid orders' shipping destinations (product_geography_evidence, migration 0061), never from the
 * AI and never from a list of famous cities.
 *  - Scope: the product's own orders when enough carry a shipping country; else its category's; else the store's.
 *    Every result says which scope it used and how many orders it rests on.
 *  - Locations: a region or city is listed only with a minimum share and count, so one order never makes a city.
 *  - Cross-border: another country appears only with measured demand (paid orders shipped there), and is recommended
 *    only when Shopify can sell and deliver there (serviceability); otherwise it is shown as demand Shopify cannot
 *    yet serve.
 * Pure and versioned; all figures are counts read from Shopify (verified).
 */
export const GEOGRAPHY_RULES = {
  version: 1,
  /** Orders with a shipping country before a scope's own mix is used. */
  productMinOrders: 20,
  categoryMinOrders: 50,
  storeMinOrders: 20,
  /** A region or city is listed at this share of the scope's addressed orders, and this many orders. */
  locationMinShare: 0.05,
  locationMinOrders: 3,
  maxLocations: 8,
  /** Paid orders shipped to another country before it counts as cross-border demand. */
  crossBorderMinOrders: 10,
} as const;

export interface GeoScopeEvidence {
  orders: number;
  with_country: number;
  countries: Array<{ country: string; orders: number }>;
  regions: Array<{ country: string; province: string; orders: number }>;
  cities: Array<{ country: string; city: string; orders: number }>;
}
export interface ProductGeographyEvidence { product_id: number; category_key: string | null; product: GeoScopeEvidence | null; category: GeoScopeEvidence | null }
export interface GeographyEvidence { as_of: string; window_days: number; store: GeoScopeEvidence; products: ProductGeographyEvidence[] }

export type GeographyScope = "product" | "category" | "store" | "none";
export interface Location { country: string; name: string; orders: number; share: number }
export interface CrossBorderDemand { country: string; orders: number; share: number; serviceability: MarketServiceability["status"] | null; recommended: boolean }
export interface ProductGeography {
  rules_version: number;
  product_id: number;
  target_country: string | null;
  scope: GeographyScope;
  /** The scope's orders with a shipping country, which every share is of. */
  scope_orders: number;
  window_days: number;
  regions: Location[];
  cities: Location[];
  cross_border: CrossBorderDemand[];
  explanation: string;
}

const listed = (orders: number, total: number) => total > 0 && orders >= GEOGRAPHY_RULES.locationMinOrders && orders / total >= GEOGRAPHY_RULES.locationMinShare;
const share = (orders: number, total: number) => Math.round((orders / total) * 1000) / 1000;

export function productGeography(evidence: GeographyEvidence, productId: number, targetCountry: string | null,
  context: ShopMarketContext | null = null, product: { requires_shipping: boolean | null } = { requires_shipping: true }): ProductGeography {
  const p = evidence.products.find((x) => x.product_id === productId);
  const country = targetCountry ? targetCountry.toUpperCase() : null;
  const candidates: Array<[GeographyScope, GeoScopeEvidence | null | undefined, number]> = [
    ["product", p?.product, GEOGRAPHY_RULES.productMinOrders],
    ["category", p?.category, GEOGRAPHY_RULES.categoryMinOrders],
    ["store", evidence.store, GEOGRAPHY_RULES.storeMinOrders],
  ];
  const chosen = candidates.find(([, geo, min]) => geo && geo.with_country >= min);
  const base = { rules_version: GEOGRAPHY_RULES.version, product_id: productId, target_country: country, window_days: evidence.window_days };
  if (!chosen) {
    return { ...base, scope: "none", scope_orders: 0, regions: [], cities: [], cross_border: [],
      explanation: `Too few paid orders with a shipping address to say where buyers are (fewer than ${GEOGRAPHY_RULES.productMinOrders} for the product, `
        + `${GEOGRAPHY_RULES.categoryMinOrders} for its category and ${GEOGRAPHY_RULES.storeMinOrders} for the store in ${evidence.window_days} days).` };
  }
  const [scope, geo] = chosen as [GeographyScope, GeoScopeEvidence, number];
  const total = geo.with_country;
  const domestic = <T extends { country: string; orders: number }>(rows: T[], name: (r: T) => string): Location[] =>
    rows.filter((r) => (country === null || r.country === country) && listed(r.orders, total)).slice(0, GEOGRAPHY_RULES.maxLocations)
      .map((r) => ({ country: r.country, name: name(r), orders: r.orders, share: share(r.orders, total) }));
  const regions = domestic(geo.regions, (r) => r.province);
  const cities = domestic(geo.cities, (r) => r.city);
  const cross_border: CrossBorderDemand[] = geo.countries
    .filter((c) => c.country !== country && c.orders >= GEOGRAPHY_RULES.crossBorderMinOrders)
    .map((c) => {
      const status = context ? assessServiceability(context, product, c.country).status : null;
      return { country: c.country, orders: c.orders, share: share(c.orders, total), serviceability: status, recommended: status === "serviced" };
    });
  const scopeText = scope === "product" ? "the product's own" : scope === "category" ? "its category's" : "the store's";
  const where = cities.length ? cities.map((c) => `${c.name} (${c.orders})`).join(", ") : regions.length ? regions.map((r) => `${r.name} (${r.orders})`).join(", ") : null;
  const abroad = cross_border.length
    ? ` Measured demand abroad: ${cross_border.map((c) => `${c.country} (${c.orders} orders${c.recommended ? "" : c.serviceability === "not_serviced" ? ", which Shopify cannot yet serve" : ", serviceability unknown"})`).join(", ")}.`
    : "";
  return { ...base, scope, scope_orders: total, regions, cities, cross_border,
    explanation: `From ${total} of ${scopeText} paid orders with a shipping address in ${evidence.window_days} days`
      + (where ? `, buyers concentrate in ${where}.` : `, no single region or city holds ${GEOGRAPHY_RULES.locationMinShare * 100}% of orders.`) + abroad };
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const scopeOf = (raw: unknown): GeoScopeEvidence | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rows = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return { orders: n(r.orders), with_country: n(r.with_country),
    countries: rows(r.countries).map((x) => ({ country: String(x.country), orders: n(x.orders) })),
    regions: rows(r.regions).map((x) => ({ country: String(x.country), province: String(x.province), orders: n(x.orders) })),
    cities: rows(r.cities).map((x) => ({ country: String(x.country), city: String(x.city), orders: n(x.orders) })) };
};
/** product_geography_evidence's JSON (0061) as typed evidence. */
export function normaliseGeographyEvidence(raw: unknown): GeographyEvidence {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { as_of: String(r.as_of ?? ""), window_days: n(r.window_days),
    store: scopeOf(r.store) ?? { orders: 0, with_country: 0, countries: [], regions: [], cities: [] },
    products: (Array.isArray(r.products) ? (r.products as Record<string, unknown>[]) : []).map((p) => ({ product_id: n(p.product_id),
      category_key: typeof p.category_key === "string" ? p.category_key : null, product: scopeOf(p.product), category: scopeOf(p.category) })) };
}
