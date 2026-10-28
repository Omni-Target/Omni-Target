// Pure, display-only derivations for the dashboard.
// Faithfully ported from the previous inline dashboard logic — behavior unchanged.
import { getAdvantagePlusGuidance } from "@/lib/advantage-plus";
import { formatCurrency } from "@/lib/currency";
import { calculateAdReadinessScore } from "@/lib/ad-readiness-score";
import {
  detectDiasporaLocations,
  isFallbackCountryEntry,
  getEffectiveStoreCountry,
  isSameCountry,
} from "@/lib/market-geography";
import type { ProductDecisionEvidence, StoreRecentFunnel } from "@/lib/store-data";

export interface OrdersData {
  orders_last_30_days?: number;
  average_order_value?: number;
  repeat_customer_rate?: number;
  median_days_to_second_order?: number | null;
  repeat_buyers_observed?: number;
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
      ? `Shopify recorded ${orders30d > 0 ? `${orders30d} orders` : `${funnel.completed_checkout_sessions} completed checkouts`} across ${funnel.checkout_sessions} online checkout sessions in the last 30 days. Optimizing for Purchase directly targets customers ready to pay. Confirm Purchase is active in Meta Events Manager before launching${conditionalAlt ? `; consider ${conditionalAlt.event === "InitiateCheckout" ? "Initiate Checkout" : "Add to Cart"} only if Meta Purchase signals prove too sparse.` : "."}`
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
  } else {
    const effectiveCountry = getEffectiveStoreCountry(undefined, currency, locations);
    const intlCountries = (orders.top_order_countries || []).filter(
      (c) => c.order_count > 0 && !isSameCountry(c.country, effectiveCountry)
    );
    if (intlCountries.length > 0) {
      const displayCountries = intlCountries
        .slice(0, 2)
        .map((c) => COUNTRY_CODES[c.country] || c.country)
        .join(" and ");
      const totalIntlOrders = intlCountries.reduce((sum, c) => sum + (c.order_count || 0), 0);
      insights.push({
        kind: "diaspora",
        title: `International buyers in ${displayCountries}`,
        detail: `You have ${totalIntlOrders} organic orders recorded from ${displayCountries}. Test reaching these overseas shoppers with dedicated ads and transparent international delivery.`,
      });
    }
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

const COUNTRY_TO_ISO: Record<string, string> = {
  nigeria: "NG",
  unitedstates: "US",
  unitedkingdom: "UK",
  canada: "CA",
  ghana: "GH",
  kenya: "KE",
  southafrica: "ZA",
  australia: "AU",
  germany: "DE",
  france: "FR",
  ireland: "IE",
  netherlands: "NL",
  unitedarabemirates: "UAE",
  dubai: "UAE",
  india: "IN",
  japan: "JP",
  brazil: "BR",
  italy: "IT",
  spain: "ES",
  switzerland: "CH",
  sweden: "SE",
  belgium: "BE",
  newzealand: "NZ",
  qatar: "QA",
  saudiarabia: "SA",
};

function normalizeCountryKey(c: string): string {
  return c.toLowerCase().replace(/[^a-z]/g, "");
}

export interface BuyerLocationInfo {
  domesticText: string;
  internationalText?: string;
  subtext: string;
  hasInternational: boolean;
  totalInternationalOrders: number;
}

/**
 * Derives top 3 domestic buyer hubs and top 3 cross-border/international destinations,
 * with dynamic order count aggregation and tailored strategic subtext.
 */
export function deriveBuyerLocations(
  orders: OrdersData,
  storeCountry?: string,
  currency?: string
): BuyerLocationInfo {
  const top = orders.top_locations || [];
  const validLocations = top.filter((loc) => !isFallbackCountryEntry(loc) && loc.city);
  const effectiveCountry = getEffectiveStoreCountry(storeCountry, currency, top);

  // 1. Split valid recorded locations into Domestic vs International
  const domesticLocations = validLocations.filter((l) =>
    isSameCountry(l.country || "", effectiveCountry)
  );
  const internationalLocations = validLocations.filter((l) =>
    !isSameCountry(l.country || "", effectiveCountry)
  );

  // 2. Format Top 3 Domestic Cities (Clean without redundant home country tags)
  let domesticText = "";
  if (domesticLocations.length > 0) {
    domesticText = domesticLocations
      .slice(0, 3)
      .map((l) => l.city!.trim())
      .join(" · ");
  } else {
    // If no domestic cities recorded, check commercial hubs fallback
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

    const primaryCountry = candidateCountries[0] || effectiveCountry;
    const primaryKey = normalizeCountryKey(primaryCountry);
    const primaryHubs = COMMERCIAL_HUBS[primaryKey] || [];
    if (primaryHubs.length > 0) {
      domesticText = primaryHubs.slice(0, 3).join(" · ");
    } else if (candidateCountries.length > 0) {
      domesticText = candidateCountries
        .slice(0, 3)
        .map((c) => COUNTRY_CODES[c] || c)
        .join(" · ");
    } else {
      domesticText = "No order locations available";
    }
  }

  // 3. International Orders & Locations (Top 3)
  const countryOrders = orders.top_order_countries || [];
  const intlCountryOrders = countryOrders.filter(
    (c) => c.order_count > 0 && !isSameCountry(c.country, effectiveCountry)
  );
  const totalInternationalOrders = intlCountryOrders.reduce(
    (sum, c) => sum + (c.order_count || 0),
    0
  );

  const intlEntries: string[] = [];
  const seenCountries = new Set<string>();

  // A. Add up to 3 recorded international cities first (e.g. "Burlington (US)")
  for (const loc of internationalLocations) {
    if (intlEntries.length >= 3) break;
    const rawCountry = loc.country || "";
    const normKey = normalizeCountryKey(rawCountry);
    const iso =
      COUNTRY_TO_ISO[normKey] ||
      (/^[A-Z]{2}$/.test(rawCountry) ? rawCountry : COUNTRY_CODES[rawCountry] || rawCountry);
    const label = iso ? `${loc.city!.trim()} (${iso})` : loc.city!.trim();
    intlEntries.push(label);
    if (normKey) seenCountries.add(normKey);
  }

  // B. If fewer than 3, add non-represented international countries from top_order_countries
  for (const c of intlCountryOrders) {
    if (intlEntries.length >= 3) break;
    const normKey = normalizeCountryKey(c.country);
    if (!seenCountries.has(normKey)) {
      const countryDisplay = COUNTRY_CODES[c.country] || c.country;
      intlEntries.push(countryDisplay);
      seenCountries.add(normKey);
    }
  }

  const hasInternational = intlEntries.length > 0 || totalInternationalOrders > 0;
  const internationalText = intlEntries.length > 0 ? intlEntries.join(" · ") : undefined;

  // 4. Dynamic Subtext
  let subtext: string;
  if (domesticText === "No order locations available") {
    subtext = "Broad market targeting recommended for initial ad tests";
  } else if (hasInternational) {
    const intlNames = [
      ...new Set(
        intlCountryOrders
          .map((c) => COUNTRY_CODES[c.country] || c.country)
          .concat(internationalLocations.map((l) => COUNTRY_CODES[l.country || ""] || l.country || ""))
          .filter(Boolean),
      ),
    ];
    const countryList =
      intlNames.slice(0, 2).join(" & ") + (intlNames.length > 2 ? " & more" : "");
    const countPart =
      totalInternationalOrders > 0 ? ` (${totalInternationalOrders} orders)` : "";
    subtext = countryList
      ? `Cross-border demand recorded in ${countryList}${countPart} · Ideal for high-margin diaspora targeting`
      : `Cross-border demand recorded${countPart} · Ideal for high-margin diaspora targeting`;
  } else {
    subtext = "Proven buyer locations recorded directly from your past customer orders";
  }

  return {
    domesticText,
    internationalText,
    subtext,
    hasInternational,
    totalInternationalOrders,
  };
}

export function deriveLocationText(
  orders: OrdersData,
  storeCountry?: string,
  currency?: string
): string {
  if (storeCountry || currency) {
    const info = deriveBuyerLocations(orders, storeCountry, currency);
    return info.internationalText
      ? `${info.domesticText} · ${info.internationalText}`
      : info.domesticText;
  }

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
    const firstPct =
      decision.identified_first_orders > 0
        ? Math.round((decision.first_order_count / decision.identified_first_orders) * 100)
        : 0;
    const coreOut = decision.variant_stock_coverage?.core_variant_stockout === true;
    const outVariants = decision.variant_stock_coverage?.stocked_out_core_variants ?? [];
    const demandShare = decision.variant_stock_coverage?.demand_weighted_stock_share;
    const multiItemRate = decision.first_order_economics?.multi_item_first_order_rate;
    const nextBridge = decision.post_entry_bridge?.top_next_product_name;
    const repeat60d = decision.follow_up_60d.repeat_rate;

    if (decision.test_readiness === "hold" || p.in_stock === false) {
      return {
        primaryMetric:
          decision.first_order_count > 0
            ? `${firstPct}% of new buyers chose this first (${decision.first_order_count} orders)`
            : "Currently out of stock",
        subtext: "Sold out right now — restock inventory before spending ad budget.",
      };
    }

    if (coreOut) {
      const lostPct =
        demandShare != null ? Math.round((1 - demandShare) * 100) : null;
      const variantLabel = outVariants.length > 0 ? outVariants.join(", ") : "Best-selling size";
      return {
        primaryMetric: `Hold off on ads — ${outVariants.length > 0 ? `option ${variantLabel} is sold out` : "popular options sold out"}`,
        subtext:
          lostPct != null
            ? `Sold-out option (${variantLabel}) drives ${lostPct}% of sales for this piece. Restock it before running ads.`
            : "Your highest-selling size or option is out of stock. Restock before running ads.",
      };
    }

    if (decision.return_evidence?.risk === "review") {
      const retPct = Math.round((decision.return_evidence.processed_return_rate ?? 0) * 100);
      return {
        primaryMetric: `${retPct}% return rate (${decision.return_evidence.processed_return_units} of ${decision.return_evidence.eligible_units} returned)`,
        subtext: "Attracts buyers, but returns are elevated — check sizing or fit details before scaling ads.",
      };
    }

    if (decision.role === "Gateway") {
      const primaryMetric = `${firstPct}% of new customers start here (${decision.first_order_count} of ${decision.identified_first_orders} first orders)`;
      let subtext = "One of your strongest entry pieces for turning cold shoppers into first-time buyers.";
      if (multiItemRate != null && multiItemRate >= 0.5) {
        subtext = `Brings new shoppers in — and ${Math.round(multiItemRate * 100)}% of them add extra items to their cart at checkout.`;
      } else if (nextBridge) {
        subtext = `Strong entry piece — first-time buyers frequently come back next for ${nextBridge}.`;
      } else if (repeat60d != null && repeat60d >= 0.12) {
        subtext = `Proven entry piece — ${Math.round(repeat60d * 100)}% of first-time buyers come back for another order within 60 days.`;
      }
      return { primaryMetric, subtext };
    }

    if (decision.role === "Consideration") {
      return {
        primaryMetric: `Chosen in ${decision.later_order_count} repeat orders`,
        subtext: "Shoppers come back for this after they know your brand — ideal for retargeting past visitors.",
      };
    }

    if (decision.role === "Hybrid") {
      return {
        primaryMetric: `${decision.first_order_count} first-time orders · ${decision.later_order_count} repeat orders`,
        subtext: "Popular with both first-time shoppers and returning customers.",
      };
    }

    return {
      primaryMetric: `${decision.first_order_count} first-time order${decision.first_order_count === 1 ? "" : "s"} recorded`,
      subtext: "Low order volume so far — test with a small budget if you want to gauge cold buyer interest.",
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
    subtext = "First-order gateway signal from accessible store orders";
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
