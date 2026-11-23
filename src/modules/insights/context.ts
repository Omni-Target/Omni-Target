import type { ShopifyShop } from "@/lib/connectors/shopify";
import { getMissingShopifyScopes } from "@/lib/shopify-config";
import type { StoreCapability, StorePrespendIntelligence } from "@/lib/store-data";

/**
 * Shop context (Phase 3, task 5): shop details and the pre-spend datasets
 * (markets, delivery zones, policies, locales, analytics, discounts, marketing
 * history), read from Shopify by a background sync and stored in shop_settings
 * and shop_context (migration 0048), so the insights worker builds a snapshot
 * from the database alone. Pure: rows to store, and the stored rows back in the
 * snapshot's shapes. Every list and text is bounded to fit the table's limits.
 */
export const SHOP_CONTEXT_VERSION = 1;
export const POLICY_TEXT_CHARS = 2_000;
/** A context older than this is reported with its age. */
export const CONTEXT_STALE_MS = 48 * 3_600_000;

export interface ShopDetails {
  name: string;
  primaryDomain: string | null;
  myshopifyDomain: string;
  currency: string;
  moneyFormat: string | null;
  timezone: string | null;
  countryCode: string | null;
  provinceCode: string | null;
  plan: { displayName: string | null; shopifyPlus: boolean | null; partnerDevelopment: boolean | null };
  weightUnit: string | null;
  taxesIncluded: boolean | null;
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");
const optional = (value: unknown, max: number): string | null => (typeof value === "string" && value ? value.slice(0, max) : null);

/** Datasets the mirror provides itself: never stored as a Shopify read. */
const MIRROR_DATASETS = new Set(["product_evidence", "return_evidence", "locations"]);

export function toContextRows(details: ShopDetails, prespend: StorePrespendIntelligence, warnings: string[], logoUrl: string | null) {
  const settings = {
    fields_version: SHOP_CONTEXT_VERSION,
    name: text(details.name, 255),
    primary_domain: optional(details.primaryDomain, 255),
    currency: /^[A-Z]{3}$/.test(details.currency) ? details.currency : null,
    money_format: optional(details.moneyFormat, 64),
    timezone: optional(details.timezone, 64),
    country_code: details.countryCode && /^[A-Z]{2}$/.test(details.countryCode) ? details.countryCode : null,
    province_code: optional(details.provinceCode, 16),
    primary_locale: optional(prespend.locales.find((l) => l.primary)?.locale, 16),
    enabled_locales: prespend.locales.filter((l) => l.published).map((l) => text(l.locale, 16)).slice(0, 100),
    shopify_plan: optional(details.plan.displayName, 64),
    shopify_plus: details.plan.shopifyPlus,
    partner_development: details.plan.partnerDevelopment,
    weight_unit: details.weightUnit ? details.weightUnit.toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 40) || null : null,
    taxes_included: details.taxesIncluded,
    logo_url: optional(logoUrl, 1024),
    markets: prespend.markets.slice(0, 50).map((m) => ({ id: text(m.id, 80), name: text(m.name, 255), status: text(m.status, 16), countries: m.countries.slice(0, 250).map((c) => text(c, 64)) })),
    delivery_summary: { zones: prespend.shipping_zones.slice(0, 200).map((z) => ({ ...z, profile_name: text(z.profile_name, 255), zone_name: text(z.zone_name, 255), countries: z.countries.slice(0, 250) })) },
    policies: { items: prespend.policies.slice(0, 10).map((p) => ({
      type: text(p.type, 40), title: text(p.title, 255), url: text(p.url, 1024), body: text(p.body, POLICY_TEXT_CHARS), truncated: p.body.length > POLICY_TEXT_CHARS,
    })) },
  };
  const capabilities = Object.fromEntries(Object.entries(prespend.capabilities).filter(([name]) => !MIRROR_DATASETS.has(name))
    .map(([name, c]) => [name, { status: c.status, required_scopes: c.required_scopes.slice(0, 10), ...(c.detail ? { detail: text(c.detail, 300) } : {}) }]));
  const context = {
    fields_version: SHOP_CONTEXT_VERSION,
    capabilities,
    analytics: prespend.analytics ? { ...prespend.analytics, top_countries: prespend.analytics.top_countries.slice(0, 20) } : null,
    discounts: prespend.active_discounts.slice(0, 100).map((d) => ({ id: text(d.id, 80), title: text(d.title, 255), summary: text(d.summary, 500), status: text(d.status, 32) })),
    marketing: prespend.marketing_history.slice(0, 100).map((m) => ({ ...m, title: m.title === undefined ? undefined : text(m.title, 255) })),
    locales: prespend.locales.slice(0, 100).map((l) => ({ locale: text(l.locale, 16), primary: Boolean(l.primary), published: Boolean(l.published) })),
    warnings: warnings.slice(0, 20).map((w) => text(w, 300)),
  };
  return { settings, context };
}

/** insight_shop_context's answer (0048). */
export interface StoredShopContext {
  settings: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  myshopify_domain: string | null;
  granted_scopes: string[];
  locations: Array<{ id: number; name: string; fulfills_online_orders: boolean | null; has_active_inventory: boolean | null; is_active: boolean }>;
}

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** The stored context in the snapshot's shapes; null when the shop's context has never been read. */
export function fromStoredContext(stored: StoredShopContext, now = Date.now()): { shop: ShopifyShop; prespend: StorePrespendIntelligence; syncedAt: string; warnings: string[] } | null {
  const s = stored.settings;
  const c = stored.context;
  if (!s || !c || typeof s.currency !== "string") return null;
  const myshopify = stored.myshopify_domain ?? "";
  const shop: ShopifyShop = {
    name: typeof s.name === "string" ? s.name : myshopify,
    domain: typeof s.primary_domain === "string" && s.primary_domain ? s.primary_domain : myshopify,
    myshopify_domain: myshopify,
    currency: s.currency,
    country_code: typeof s.country_code === "string" ? s.country_code : "",
    ...(typeof s.money_format === "string" && s.money_format ? { money_format: s.money_format } : {}),
  };
  const capabilities = { ...(c.capabilities as Record<string, StoreCapability>) };
  capabilities.locations = stored.locations.length
    ? { status: "available", required_scopes: ["read_locations"], detail: "From the stored locations" }
    : { status: "unavailable", required_scopes: ["read_locations"], detail: "No location stored" };
  const prespend: StorePrespendIntelligence = {
    granted_scopes: stored.granted_scopes,
    missing_required_scopes: stored.granted_scopes.length ? getMissingShopifyScopes(stored.granted_scopes) : [],
    capabilities,
    ...(c.analytics ? { analytics: c.analytics as StorePrespendIntelligence["analytics"] } : {}),
    markets: list(s.markets),
    shipping_zones: list((s.delivery_summary as { zones?: unknown } | null)?.zones),
    fulfillment_locations: stored.locations.filter((l) => l.is_active).map((l) => ({
      id: `gid://shopify/Location/${l.id}`, name: l.name, fulfills_online_orders: Boolean(l.fulfills_online_orders), has_active_inventory: Boolean(l.has_active_inventory),
    })),
    active_discounts: list(c.discounts),
    marketing_history: list(c.marketing),
    policies: list<{ type: string; title: string; body: string; url: string }>((s.policies as { items?: unknown } | null)?.items).map(({ type, title, body, url }) => ({ type, title, body, url })),
    locales: list(c.locales),
  };
  const syncedAt = String(c.synced_at ?? s.synced_at ?? "");
  const warnings = [...list<string>(c.warnings)];
  const age = now - Date.parse(syncedAt);
  if (Number.isFinite(age) && age > CONTEXT_STALE_MS) warnings.push(`Shop settings and pre-spend data were last read from Shopify ${Math.round(age / 3_600_000)} hours ago.`);
  return { shop, prespend, syncedAt, warnings };
}
