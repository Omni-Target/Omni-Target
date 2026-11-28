/**
 * Market serviceability (Phase 5, task 3; architecture/phase-5-intelligence.md, "Market serviceability"). Whether a
 * product can be sold into the target country, from the shop's own Shopify configuration:
 *  - market: an ACTIVE Shopify market contains the country (a draft market sells nothing);
 *  - shipping (products that are shipped): a delivery zone with active rates covers the country in a profile every
 *    product falls under: one that covers all items, or the General (default) profile when every custom profile
 *    covers the country too. Which products a custom profile holds is not read, so a country reached only by some
 *    profiles is unknown. Not serviced only when no zone with rates covers it.
 * Unknown evidence (scopes, never synced) never blocks. The result feeds the economics engine as
 * `targetMarketServiced`: not serviced blocks a GO or PILOT product; it never changes another verdict.
 * Pure and versioned; every check names its evidence, labelled verified (read from Shopify) or unknown.
 */
export const SERVICEABILITY_RULES_VERSION = 1;

export interface MarketRecord { id?: string; name: string; status: string; countries: string[] }
export interface ShippingZoneRecord {
  profile_id?: string;
  profile_name: string;
  /** Shopify's coversAllItems: the profile's rates apply to every item, overriding product assignments. */
  applies_to_all_products: boolean;
  /** Shopify's default (General) profile, for every product not in a custom profile; null when not read. */
  default_profile: boolean | null;
  zone_name: string;
  countries: string[];
  active_methods: number;
}

/** What the shop's Shopify configuration says, as stored by the shop-context sync (0048). */
export interface ShopMarketContext {
  shop_country: string | null;
  markets: MarketRecord[];
  zones: ShippingZoneRecord[];
  /** Whether each dataset was read: Shopify's capability status ("available" when read in full). */
  markets_read: boolean;
  shipping_read: boolean;
  /** When the shop context was last read from Shopify. */
  synced_at: string | null;
}

export type CheckState = "pass" | "fail" | "unknown" | "not_needed";
export interface ServiceabilityCheck { state: CheckState; evidence: string }
export interface MarketServiceability {
  rules_version: number;
  target_country: string | null;
  status: "serviced" | "not_serviced" | "unknown";
  checks: { market: ServiceabilityCheck; shipping: ServiceabilityCheck };
  explanation: string;
  synced_at: string | null;
}

const code = (c: string) => c.trim().toUpperCase();

export function assessServiceability(context: ShopMarketContext, product: { requires_shipping: boolean | null }, targetCountry?: string | null): MarketServiceability {
  const country = targetCountry ? code(targetCountry) : context.shop_country ? code(context.shop_country) : null;
  const base = { rules_version: SERVICEABILITY_RULES_VERSION, target_country: country, synced_at: context.synced_at };
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    const unknown = { state: "unknown" as const, evidence: "No target country, and the shop's own country is not known." };
    return { ...base, status: "unknown", checks: { market: unknown, shipping: unknown }, explanation: unknown.evidence };
  }

  let market: ServiceabilityCheck;
  if (!context.markets_read || context.markets.length === 0) {
    market = { state: "unknown", evidence: "Shopify's markets could not be read." };
  } else {
    const active = context.markets.filter((m) => m.status.toUpperCase() === "ACTIVE" && m.countries.some((c) => code(c) === country));
    const draft = context.markets.filter((m) => m.status.toUpperCase() !== "ACTIVE" && m.countries.some((c) => code(c) === country));
    market = active.length
      ? { state: "pass", evidence: `${country} is in the active market ${active.map((m) => `"${m.name}"`).join(", ")}.` }
      : { state: "fail", evidence: draft.length
        ? `${country} is only in a market that is not active (${draft.map((m) => `"${m.name}", ${m.status.toLowerCase()}`).join("; ")}).`
        : `No Shopify market contains ${country}.` };
  }

  let shipping: ServiceabilityCheck;
  if (product.requires_shipping === false) {
    shipping = { state: "not_needed", evidence: "The product is not shipped." };
  } else if (!context.shipping_read) {
    shipping = { state: "unknown", evidence: "Shopify's shipping zones could not be read." };
  } else {
    const covers = (z: ShippingZoneRecord) => z.active_methods > 0 && z.countries.some((c) => code(c) === country || code(c) === "REST_OF_WORLD");
    const profileOf = (z: ShippingZoneRecord) => z.profile_id ?? z.profile_name;
    const covering = context.zones.filter(covers);
    const everyItem = covering.find((z) => z.applies_to_all_products);
    const general = covering.find((z) => z.default_profile === true);
    const customProfiles = [...new Set(context.zones.filter((z) => z.default_profile === false && !z.applies_to_all_products).map(profileOf))];
    const customMissing = customProfiles.filter((p) => !covering.some((z) => profileOf(z) === p));
    const nameOf = (p: string) => context.zones.find((z) => profileOf(z) === p)?.profile_name ?? p;
    if (everyItem) {
      shipping = { state: "pass", evidence: `Shipping zone "${everyItem.zone_name}" (profile "${everyItem.profile_name}", which covers every item) ships to ${country}.` };
    } else if (general && customMissing.length === 0) {
      shipping = { state: "pass", evidence: `Shipping zone "${general.zone_name}" (the General profile "${general.profile_name}") ships to ${country}`
        + (customProfiles.length ? `, as does every custom profile.` : `, and there is no custom profile.`) };
    } else if (general) {
      shipping = { state: "unknown", evidence: `The General profile ships to ${country}, but the custom profile ${customMissing.map((p) => `"${nameOf(p)}"`).join(", ")} does not, `
        + "and which products it holds is not read." };
    } else if (covering.length) {
      shipping = { state: "unknown", evidence: covering.some((z) => z.default_profile === null)
        ? `A shipping zone ships to ${country}, but whether its profile ("${covering[0].profile_name}") is the General profile has not been read yet.`
        : `Only the custom profile "${covering[0].profile_name}" ships to ${country}, and which products it holds is not read.` };
    } else {
      shipping = { state: "fail", evidence: `No shipping zone with active rates ships to ${country}.` };
    }
  }

  const failed = [market, shipping].filter((c) => c.state === "fail");
  const unknown = [market, shipping].filter((c) => c.state === "unknown");
  const status = failed.length ? "not_serviced" : unknown.length ? "unknown" : "serviced";
  const explanation = status === "serviced" ? `The product can be sold and delivered to ${country}: ${market.evidence} ${shipping.evidence}`
    : status === "not_serviced" ? `The product cannot be sold or delivered to ${country}: ${failed.map((c) => c.evidence).join(" ")}`
    : `Whether the product can be sold and delivered to ${country} is not known: ${unknown.map((c) => c.evidence).join(" ")}`;
  return { ...base, status, checks: { market, shipping }, explanation };
}

/** What the economics engine receives: true, false, or null when not known. */
export const servicedFlag = (s: MarketServiceability): boolean | null => (s.status === "serviced" ? true : s.status === "not_serviced" ? false : null);

/** shop_settings and shop_context as typed context (missing or malformed parts read as not available). */
export function toShopMarketContext(settings: Record<string, unknown> | null, capabilities: Record<string, unknown> | null, syncedAt: string | null): ShopMarketContext {
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : []);
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const read = (name: string) => ((capabilities?.[name] as { status?: unknown } | undefined)?.status === "available");
  const zones = list((settings?.delivery_summary as { zones?: unknown } | undefined)?.zones);
  return {
    shop_country: typeof settings?.country_code === "string" ? settings.country_code : null,
    markets: list(settings?.markets).map((m) => ({ id: typeof m.id === "string" ? m.id : undefined, name: String(m.name ?? ""), status: String(m.status ?? ""), countries: strings(m.countries) })),
    zones: zones.map((z) => ({ ...(typeof z.profile_id === "string" ? { profile_id: z.profile_id } : {}), profile_name: String(z.profile_name ?? ""),
      applies_to_all_products: z.applies_to_all_products === true,
      default_profile: typeof z.default_profile === "boolean" ? z.default_profile : null, zone_name: String(z.zone_name ?? ""),
      countries: strings(z.countries), active_methods: typeof z.active_methods === "number" ? z.active_methods : 0 })),
    markets_read: read("markets"),
    shipping_read: read("shipping"),
    synced_at: syncedAt,
  };
}
