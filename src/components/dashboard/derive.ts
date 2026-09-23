// Pure, display-only derivations for the dashboard.
// Faithfully ported from the previous inline dashboard logic — behavior unchanged.
import { getAdvantagePlusGuidance } from "@/lib/advantage-plus";
import { formatCurrency } from "@/lib/currency";
import { calculateAdReadinessScore } from "@/lib/ad-readiness-score";
import { detectDiasporaLocations, isFallbackCountryEntry } from "@/lib/market-geography";
import type { ProductDecisionEvidence, StoreRecentFunnel } from "@/lib/store-data";

export interface OrdersData {
  orders_last_30_days?: number;
  average_order_value?: number;
  repeat_customer_rate?: number;
  revenue_last_30_days?: number;
  top_locations?: Array<{ city?: string; country?: string }>;
  top_order_countries?: Array<{ country: string; order_count: number }>;
  peak_days?: string[];
  acquisition_channels?: Array<{ channel: string; order_count: number; percentage: number }>;
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
  product_decision?: ProductDecisionEvidence;
  in_stock_variant_count?: number;
  total_variant_count?: number;
  unit_cost_coverage?: "complete" | "partial" | "missing";
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

export function deriveInsights(orders: OrdersData, currency = "USD", recentFunnel?: StoreRecentFunnel | null): Insight[] {
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
      title: "High-ticket trust strategy",
      detail: `At an average basket of ${formattedAov}, shoppers need reassurance before checkout. Use video try-ons, customer unboxing, and clear exchange policies to eliminate purchase hesitation.`,
    });
  }

  // 2. Launch Event & Optimization (Grounded in Storefront Funnel Evidence)
  if (orders30d > 0 || recentFunnel) {
    const eventGuidance = getAdvantagePlusGuidance(orders30d, recentFunnel);
    const funnel = eventGuidance.event_evidence.recent_funnel;
    const conditionalAlt = eventGuidance.event_evidence.conditional_alternative;

    const detailText = funnel
      ? `Shopify recorded ${funnel.completed_checkout_sessions} completed checkouts out of ${funnel.checkout_sessions} checkout sessions. Optimizing for Purchase directly targets paying customers. Confirm Purchase is active in Meta Events Manager before launching${conditionalAlt ? `; consider ${conditionalAlt.event === "InitiateCheckout" ? "Initiate Checkout" : "Add to Cart"} only if Meta Purchase signals prove too sparse.` : "."}`
      : `Shopify recorded ${orders30d} recent orders. Purchase best matches your goal of acquiring paying buyers. Confirm the Purchase event is active in Meta Events Manager before publishing${orders30d < 15 ? "; if measured purchase signals prove too sparse during testing, consider Initiate Checkout as a backup." : "."}`;

    insights.push({
      kind: "scale",
      title: "Recommended launch event: Purchase",
      detail: detailText,
    });
  }

  // 3. Diaspora Market Opportunity
  const diasporaMatches = detectDiasporaLocations(locations);
  if (diasporaMatches.length > 0) {
    const displayCities = diasporaMatches.slice(0, 2).map((m) => m.city).join(" and ");
    insights.push({
      kind: "diaspora",
      title: `International buyers in ${displayCities}`,
      detail: `You have organic orders coming from ${displayCities}. Test reaching these diaspora communities with clear international shipping terms.`,
    });
  }

  // 4. Launch Timing & Pacing
  if (peakDays.length > 0) {
    const days = peakDays.slice(0, 2).join(" and ");
    insights.push({
      kind: "timing",
      title: `Launch around ${peakDays[0]}`,
      detail: `Shoppers buy most frequently on ${days}. Launch your campaign or scale budget on ${peakDays[0]} to capture buyers during peak shopping momentum.`,
    });
  }

  // 5. Seed Audience Signals
  if (repeatRate > 0.15 && insights.length < 4) {
    insights.push({
      kind: "lookalike",
      title: "Turn loyalty into new customers",
      detail: `${Math.round(repeatRate * 100)}% of your customers buy again. Feature rave customer reviews and product durability to convert hesitant first-time shoppers.`,
    });
  }

  // 6. Acquisition Channel Signal
  if (orders.acquisition_channels && orders.acquisition_channels.length > 0 && insights.length < 4) {
    const top = orders.acquisition_channels[0];
    if (top && top.percentage > 0) {
      insights.push({
        kind: "scale",
        title: `${top.channel} is your top acquisition channel`,
        detail: `${top.percentage}% of your sales come through ${top.channel}. Turn your top-performing organic posts into ad creatives to mirror what already works.`,
      });
    }
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

const COMMERCIAL_HUBS: Record<string, string[]> = {
  nigeria: ["Lagos", "Abuja", "Port Harcourt"],
  ng: ["Lagos", "Abuja", "Port Harcourt"],
  unitedkingdom: ["London", "Manchester"],
  gb: ["London", "Manchester"],
  uk: ["London", "Manchester"],
  unitedstates: ["New York", "Houston", "Atlanta"],
  us: ["New York", "Houston", "Atlanta"],
  usa: ["New York", "Houston", "Atlanta"],
  ghana: ["Accra", "Kumasi"],
  gh: ["Accra", "Kumasi"],
  kenya: ["Nairobi", "Mombasa"],
  ke: ["Nairobi", "Mombasa"],
  southafrica: ["Johannesburg", "Cape Town"],
  za: ["Johannesburg", "Cape Town"],
  canada: ["Toronto", "Vancouver"],
  ca: ["Toronto", "Vancouver"],
  unitedarabemirates: ["Dubai", "Abu Dhabi"],
  ae: ["Dubai", "Abu Dhabi"],
  dubai: ["Dubai", "Abu Dhabi"],
};

function normalizeCountryKey(c: string): string {
  return c.toLowerCase().replace(/[^a-z]/g, "");
}

export function deriveLocationText(orders: OrdersData): string {
  const formatLocation = (l: { city?: string; country?: string }) => {
    const countryDisplay = COUNTRY_CODES[l.country || ""] || l.country || "";
    return countryDisplay && countryDisplay.toLowerCase() !== l.city?.toLowerCase()
      ? `${l.city}, ${countryDisplay}`
      : l.city;
  };
  const top = orders.top_locations || [];
  const validLocations = top.filter((loc) => !isFallbackCountryEntry(loc)).slice(0, 3);
  if (validLocations.length > 0) return validLocations.map(formatLocation).join(" · ");

  // When Shopify omits or redacts cities (common under Level 2 customer privacy protection),
  // map the store's proven order volume to the top commercial ad-targeting hubs (3 to 4 cities)
  // where courier delivery and purchasing power are concentrated.
  const countryOrders = (orders.top_order_countries || []).filter((entry) => entry.order_count > 0);
  const candidateCountries: string[] = countryOrders.length > 0
    ? countryOrders.map((e) => e.country)
    : [
        ...new Set(
          top
            .map((l) => COUNTRY_CODES[l.country || ""] || l.country || l.city || "")
            .filter(Boolean),
        ),
      ];

  if (candidateCountries.length > 0) {
    const primaryCountry = candidateCountries[0];
    const primaryKey = normalizeCountryKey(primaryCountry);
    const primaryHubs = COMMERCIAL_HUBS[primaryKey] || [];

    if (primaryHubs.length > 0) {
      const selectedCities: string[] = [...primaryHubs];

      // If there are secondary cross-border order countries (e.g. US, UK diaspora orders),
      // include the top commercial diaspora hub for a 4th targeting slot.
      for (let i = 1; i < candidateCountries.length && selectedCities.length < 4; i++) {
        const secCountry = candidateCountries[i];
        const secKey = normalizeCountryKey(secCountry);
        const secHubs = COMMERCIAL_HUBS[secKey];
        if (secHubs && secHubs.length > 0) {
          const topSecHub = secHubs[0];
          if (!selectedCities.includes(topSecHub)) {
            selectedCities.push(topSecHub);
          }
        }
      }

      return selectedCities.slice(0, 4).join(" · ");
    }

    return candidateCountries
      .slice(0, 3)
      .map((c) => COUNTRY_CODES[c] || c)
      .join(" · ");
  }

  return "No order locations available";
}

export interface ProductNarrative {
  subtext: string;
  primaryMetric: string;
}

export function deriveProductNarrative(p: StoreProductLike): ProductNarrative {
  if (p.product_decision) {
    const decision = p.product_decision;
    const role = decision.role === "Gateway"
      ? decision.role_confidence === "strong"
        ? "Proven gateway — your top customer acquisition magnet"
        : "Gateway product — strong entry product for new buyers"
      : decision.role === "Consideration"
        ? "Repeat favorite — shines in retargeting and follow-up purchases"
        : decision.role === "Hybrid"
          ? "Bestseller — popular with both first-time and returning buyers"
          : "Catalog contender — test creative to gauge buyer response";
    const readiness =
      decision.test_readiness === "hold"
        ? "Restock inventory before launching ads."
        : decision.test_readiness === "review"
          ? "Check variant stock & margins before launching."
          : "In stock and ready to test with ads.";
    const primaryMetric =
      decision.role === "Gateway"
        ? `${decision.first_order_count} new customer orders`
        : decision.role === "Consideration"
          ? `${decision.later_order_count} repeat orders`
          : decision.role === "Hybrid"
            ? `${decision.first_order_count} first / ${decision.later_order_count} repeat orders`
            : `${decision.first_order_count} first orders recorded`;
    return {
      subtext: `${role}. ${readiness}`,
      primaryMetric,
    };
  }
  let subtext = "";
  let primaryMetric = "";

  if (p.gateway_classification === "Gateway" && p.first_time_buyer_ratio) {
    primaryMetric = `${Math.round(p.first_time_buyer_ratio * 100)}% new buyers`;
  } else if (p.gateway_classification === "Consideration" && p.repeat_purchase_rate) {
    primaryMetric = `${Math.round(p.repeat_purchase_rate * 100)}% repeat rate`;
  } else if (p.order_velocity) {
    primaryMetric = `${Math.round(p.order_velocity)} orders/month`;
  } else if (p.first_time_buyer_ratio) {
    primaryMetric = `${Math.round(p.first_time_buyer_ratio * 100)}% new buyers`;
  }

  if (p.gateway_classification === "Insufficient Data") {
    subtext = "New arrival — create an ad brief to introduce it to shoppers";
  } else if (p.gateway_classification === "Gateway") {
    subtext = "Top customer acquisition product for winning new shoppers";
  } else if (p.gateway_classification === "Consideration") {
    subtext = "Customer favorite for repeat orders and cross-sells";
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
