// Pure, display-only derivations for the dashboard.
// Faithfully ported from the previous inline dashboard logic — behavior unchanged.
import { clamp } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import { calculateAdReadinessScore } from "@/lib/ad-readiness-score";

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

/** Canonical 0–100 Ad Readiness score for the command-center gauge (synchronized with Audit). */
export function deriveHealthScore(
  products: StoreProductLike[] = [],
  orders: OrdersData = {},
): number {
  return calculateAdReadinessScore(
    products.map((p) => ({
      in_stock: !!p.in_stock,
      units_sold: p.units_sold,
      order_count: p.order_count,
      gateway_classification: p.gateway_classification,
      name: p.name,
    })),
    orders,
  ).totalScore;
}

export type InsightKind = "premium" | "lookalike" | "timing" | "scale" | "diaspora";
export interface Insight {
  kind: InsightKind;
  title: string;
  detail: string;
}

export function deriveInsights(orders: OrdersData, currency = "USD"): Insight[] {
  const insights: Insight[] = [];
  const aov = orders.average_order_value || 0;
  const repeatRate = orders.repeat_customer_rate || 0;
  const peakDays = orders.peak_days || [];
  const orders30d = orders.orders_last_30_days || 0;
  const locations = orders.top_locations || [];

  const isHighAov = currency === "NGN" ? aov >= 100000 : aov >= 75;

  // 1. Creative-First Positioning (High AOV)
  if (isHighAov) {
    const formattedAov = formatCurrency(Math.round(aov), currency);
    insights.push({
      kind: "premium",
      title: "Showcase the quality & details",
      detail: `Your average order is ${formattedAov}. Shoppers buy because of your craft and quality. In your ad videos, show close-ups of the fabric, stitching, and styling.`,
    });
  }

  // 2. Pixel Learning & Signal Density
  if (orders30d > 0 && orders30d < 30) {
    insights.push({
      kind: "scale",
      title: "Start with 'Add to Cart' ads",
      detail: `With ${orders30d} orders this month, optimizing for 'Add to Cart' trains Meta faster and protects your budget while sales ramp up.`,
    });
  } else if (orders30d >= 30) {
    insights.push({
      kind: "scale",
      title: "Ready for direct Purchase ads",
      detail: `With ${orders30d} monthly orders, your store has strong sales data. You can optimize ads directly for 'Purchase' to maximize revenue.`,
    });
  }

  // 3. Diaspora Market Opportunity
  const intlLocs = locations
    .filter((l) => {
      const c = (l.country || "").toLowerCase();
      return (
        c.includes("united states") ||
        c.includes("united kingdom") ||
        c.includes("canada") ||
        c.includes("ghana") ||
        c.includes("uae") ||
        (l.city && ["london", "new york", "houston", "toronto", "atlanta"].some((city) => l.city?.toLowerCase().includes(city)))
      );
    })
    .map((l) => l.city || l.country || "")
    .filter(Boolean);

  if (intlLocs.length > 0) {
    const displayCities = Array.from(new Set(intlLocs)).slice(0, 2).join(" and ");
    insights.push({
      kind: "diaspora",
      title: `International buyers in ${displayCities}`,
      detail: `Shoppers in ${displayCities} are already buying from your store. Run targeted ads to these overseas cities to capture high-margin orders.`,
    });
  }

  // 4. Launch Timing & Pacing
  if (peakDays.length > 0) {
    const days = peakDays.slice(0, 2).join(" and ");
    insights.push({
      kind: "timing",
      title: "Best days to run your ads",
      detail: `Your shoppers buy most on ${days}. Launch your ads on Thursday evening so they build momentum before the weekend rush.`,
    });
  }

  // 5. Seed Audience Signals
  if (repeatRate > 0.15 && insights.length < 4) {
    insights.push({
      kind: "lookalike",
      title: "Target people like your top buyers",
      detail: `${Math.round(repeatRate * 100)}% of your customers come back to buy again. Meta can use your past customer list to automatically find new shoppers with similar taste.`,
    });
  }

  return insights.slice(0, 4);
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
    subtext = "New arrival — create an ad brief to introduce it";
  } else if (p.gateway_classification === "Gateway") {
    subtext = "Gateway product — best for attracting new customers (most sales from first-timers)";
  } else if (p.gateway_classification === "Consideration") {
    subtext = "Loyal customer favorite — drives high repeat purchases";
  } else if (p.gateway_classification === "Hybrid") {
    subtext = "All-around favorite — popular with both new and returning shoppers";
  } else {
    subtext = "Solid seller with steady customer interest";
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
