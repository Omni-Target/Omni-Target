// Pure, display-only derivations for the dashboard.
// Faithfully ported from the previous inline dashboard logic — behavior unchanged.
import { clamp } from "@/lib/utils";

export interface OrdersData {
  orders_last_30_days?: number;
  average_order_value?: number;
  repeat_customer_rate?: number;
  revenue_last_30_days?: number;
  top_locations?: Array<{ city?: string; country?: string }>;
  peak_days?: string[];
}

export interface StoreProductLike {
  id?: string | number;
  name?: string;
  in_stock?: boolean;
  revenue?: number;
  price?: number;
  units_sold?: number;
  order_count?: number;
  image_url?: string;
  description?: string;
  product_type?: string;
  tags?: string[];
  created_at?: string;
  should_advertise?: boolean;
  gateway_classification?: string;
  first_time_buyer_ratio?: number;
  repeat_purchase_rate?: number;
  order_velocity?: number;
}

export type AdReadiness = "ready" | "ready_with_warnings" | "caution" | "not_ready";

export interface AdReadinessResult {
  readiness: AdReadiness;
  hasProducts: boolean;
  hasRecentOrders: boolean;
  outOfStockRatio: number;
}

export function deriveAdReadiness(
  products: StoreProductLike[],
  orders: OrdersData,
): AdReadinessResult {
  const outOfStockRatio =
    products.length > 0
      ? products.filter((p) => !p.in_stock).length / products.length
      : 1;
  const hasRecentOrders = (orders.orders_last_30_days ?? 0) > 0;
  const hasProducts = products.length > 0;

  const readiness: AdReadiness = !hasProducts
    ? "not_ready"
    : outOfStockRatio > 0.8
      ? "caution"
      : !hasRecentOrders
        ? "caution"
        : outOfStockRatio > 0.5
          ? "ready_with_warnings"
          : "ready";

  return { readiness, hasProducts, hasRecentOrders, outOfStockRatio };
}

/** A blended 0–100 store-health score for the command-center gauge (display-only). */
export function deriveHealthScore(
  products: StoreProductLike[],
  orders: OrdersData,
): number {
  const inStock = products.filter((p) => p.in_stock).length;
  const availability = products.length ? (inStock / products.length) * 30 : 0;
  const ordersScore = clamp((orders.orders_last_30_days ?? 0) / 20, 0, 1) * 30;
  const retention = clamp((orders.repeat_customer_rate ?? 0) / 0.3, 0, 1) * 20;
  const catalog = clamp(products.length / 10, 0, 1) * 20;
  return Math.round(availability + ordersScore + retention + catalog);
}

export type InsightKind = "premium" | "lookalike" | "timing" | "scale";
export interface Insight {
  kind: InsightKind;
  title: string;
  detail: string;
}

export function deriveInsights(orders: OrdersData): Insight[] {
  const insights: Insight[] = [];
  const aov = orders.average_order_value || 0;
  const repeatRate = orders.repeat_customer_rate || 0;
  const peakDays = orders.peak_days || [];
  const orders30d = orders.orders_last_30_days || 0;

  if (aov > 100000) {
    insights.push({
      kind: "premium",
      title: "Premium positioning works",
      detail: `Your average order of ₦${Math.round(aov / 1000)}k means buyers trust your pricing. Target 'Luxury goods' and 'Fashion enthusiasts' in Meta.`,
    });
  }
  if (repeatRate > 0.2) {
    insights.push({
      kind: "lookalike",
      title: "Build a lookalike audience",
      detail: `${Math.round(repeatRate * 100)}% of your buyers return. Upload your customer list to Meta and create a lookalike — these are your best potential new customers.`,
    });
  }
  if (peakDays.includes("Saturday") || peakDays.includes("Sunday")) {
    insights.push({
      kind: "timing",
      title: "Time your campaigns right",
      detail: `Your buyers are most active on ${peakDays.slice(0, 2).join(" and ")}. Launch your Meta campaigns on Thursday evening to build momentum before the weekend.`,
    });
  }
  if (orders30d >= 10 && orders30d < 30) {
    insights.push({
      kind: "scale",
      title: "Ready to scale",
      detail: `${orders30d} orders last month without paid ads shows organic demand. A targeted Meta campaign could multiply this significantly.`,
    });
  }
  return insights;
}

const COUNTRY_CODES: Record<string, string> = {
  NG: "Nigeria", GB: "United Kingdom", US: "United States", AE: "UAE", GH: "Ghana",
  KE: "Kenya", ZA: "South Africa", CA: "Canada", AU: "Australia", HU: "Hungary",
  DE: "Germany", FR: "France", IT: "Italy", ES: "Spain", NL: "Netherlands",
  BE: "Belgium", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland",
  PL: "Poland", RO: "Romania", CZ: "Czech Republic", PT: "Portugal", AT: "Austria",
  CH: "Switzerland", IN: "India", CN: "China", JP: "Japan", KR: "South Korea",
  BR: "Brazil", MX: "Mexico", AR: "Argentina",
};

export function deriveLocationText(orders: OrdersData): string {
  const isFallbackCountryEntry = (loc: { city?: string; country?: string }): boolean => {
    const city = loc.city?.trim() || "";
    const country = loc.country?.trim() || "";
    if (!city) return true;
    if (city.toLowerCase() === country.toLowerCase()) return true;
    if (/^[A-Z]{2}$/.test(city)) return true;
    const resolvedCountry = COUNTRY_CODES[country] || country;
    if (city.toLowerCase() === resolvedCountry.toLowerCase()) return true;
    return false;
  };
  const formatLocation = (l: { city?: string; country?: string }) => {
    const countryDisplay = COUNTRY_CODES[l.country || ""] || l.country || "";
    return countryDisplay && countryDisplay.toLowerCase() !== l.city?.toLowerCase()
      ? `${l.city}, ${countryDisplay}`
      : l.city;
  };
  const top = orders.top_locations || [];
  const validLocations = top.filter((loc) => !isFallbackCountryEntry(loc)).slice(0, 3);
  const countryFallback =
    validLocations.length === 0
      ? [
          ...new Set(
            top
              .map(
                (l) =>
                  COUNTRY_CODES[l.country || ""] ||
                  COUNTRY_CODES[l.city || ""] ||
                  l.country ||
                  l.city ||
                  "",
              )
              .filter(Boolean),
          ),
        ]
          .slice(0, 3)
          .join(" · ")
      : "";
  return validLocations.length > 0
    ? validLocations.map(formatLocation).join(" · ")
    : countryFallback || "Order location data still building";
}

export interface ProductNarrative {
  subtext: string;
  primaryMetric: string;
}

export function deriveProductNarrative(p: StoreProductLike): ProductNarrative {
  let subtext = "";
  let primaryMetric = "";

  if (p.gateway_classification === "Gateway" && p.first_time_buyer_ratio) {
    primaryMetric = `${Math.round(p.first_time_buyer_ratio * 100)}% new buyers`;
  } else if (p.gateway_classification === "Consideration" && p.repeat_purchase_rate) {
    primaryMetric = `${Math.round(p.repeat_purchase_rate * 100)}% repeat rate`;
  } else if (p.order_velocity) {
    primaryMetric = `${Math.round(p.order_velocity)} units/mo velocity`;
  } else if (p.first_time_buyer_ratio) {
    primaryMetric = `${Math.round(p.first_time_buyer_ratio * 100)}% new buyers`;
  }

  if (p.gateway_classification === "Insufficient Data") {
    subtext = "Too early to classify — keep selling";
  } else if (p.gateway_classification === "Gateway") {
    subtext = "Great for cold traffic — most buyers are first-timers";
  } else if (p.gateway_classification === "Consideration") {
    subtext = "High consideration builder — drives high repeat purchase rates";
  } else if (p.gateway_classification === "Hybrid") {
    subtext = "Balanced shopper response — mixed signals across new and repeat buyers";
  } else {
    subtext = "Consistent behavioral performance across core acquisition metrics";
  }
  return { subtext, primaryMetric };
}

/** The exact sessionStorage draft shape consumed by /campaigns. */
export function buildCampaignDraft(p: StoreProductLike, isNewLaunch = false) {
  const draft: Record<string, unknown> = {
    product_name: p.name,
    product_description: p.description || p.name,
    product_type: p.product_type || "",
    product_tags: p.tags?.join(",") || "",
    product_price: p.price,
    product_image: p.image_url || "",
  };
  if (isNewLaunch) draft.is_new_launch = true;
  return draft;
}
