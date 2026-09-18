import { isDomesticCity } from "@/lib/market-geography";

/**
 * Generates dynamic qualitative behavioral instructions based on the store's
 * primary customer acquisition channel (e.g. Instagram, TikTok, Google, Email, Direct).
 */
export function getChannelBehavioralGuidance(
  channel?: string | null,
  percentage?: number | null
): string {
  if (!channel) return "";
  const pctStr =
    typeof percentage === "number" && percentage > 0
      ? ` (${percentage}% of historical store orders)`
      : "";
  const ch = channel.toLowerCase();

  if (ch.includes("instagram") || ch.includes("facebook") || ch.includes("meta")) {
    return `BEHAVIORAL ACQUISITION CHANNEL CONTEXT:
- Primary Entry Channel: ${channel}${pctStr}
- Customer Psychology: Shoppers primarily discover this store in visual scrolling mode on ${channel}. They ignore corporate slogans and dry spec sheets. Write for cold, visual-first scrollers who respond to tactile movement, fabric drape, silhouette fit, and relatable real-world styling over retail claims.`;
  }

  if (ch.includes("tiktok")) {
    return `BEHAVIORAL ACQUISITION CHANNEL CONTEXT:
- Primary Entry Channel: ${channel}${pctStr}
- Customer Psychology: Shoppers discover this store on TikTok. They crave unvarnished authenticity, quick pattern interrupts, candid UGC-style problem-solution framing, and energetic real-life demonstrations over traditional polished studio advertisements.`;
  }

  if (ch.includes("google") || ch.includes("search")) {
    return `BEHAVIORAL ACQUISITION CHANNEL CONTEXT:
- Primary Entry Channel: ${channel}${pctStr}
- Customer Psychology: Shoppers arrive with high purchase intent searching for specific solutions. Write with functional clarity, unmistakable differentiators, and immediate value proof rather than vague lifestyle imagery.`;
  }

  if (ch.includes("email") || ch.includes("newsletter") || ch.includes("klaviyo")) {
    return `BEHAVIORAL ACQUISITION CHANNEL CONTEXT:
- Primary Entry Channel: ${channel}${pctStr}
- Customer Psychology: Shoppers have an established high-trust relationship with the brand community. For cold Meta ads, translate that intimate brand affinity into warm, confident, founder-led conviction that makes strangers feel like insiders.`;
  }

  if (ch.includes("pinterest")) {
    return `BEHAVIORAL ACQUISITION CHANNEL CONTEXT:
- Primary Entry Channel: ${channel}${pctStr}
- Customer Psychology: Shoppers arrive via visual curation and project planning. Focus on aesthetic cohesion, seasonal mood curation, and intentional wardrobe/home integration.`;
  }

  if (ch.includes("direct") || ch.includes("organic")) {
    return `BEHAVIORAL ACQUISITION CHANNEL CONTEXT:
- Primary Entry Channel: ${channel}${pctStr}
- Customer Psychology: Strong direct and organic traffic indicates organic prestige, brand reputation, and word-of-mouth. Emphasize the unique brand signatures and unmistakable craft that customers tell their friends about.`;
  }

  return `BEHAVIORAL ACQUISITION CHANNEL CONTEXT:
- Primary Entry Channel: ${channel}${pctStr}
- Customer Psychology: Shoppers convert when clear value meets compelling sensory proof. Focus on the tangible transformation, craft, and effortless daily utility of the product.`;
}

/**
 * Dynamically synthesizes domestic core markets vs. cross-border export markets
 * for any store globally using the market geography resolver.
 */
export function getGeographicBuyingDynamics(
  storeCountry?: string | null,
  currency?: string | null,
  topLocations?: Array<{ city?: string; country?: string; percentage?: number }> | null
): string {
  if (!topLocations || topLocations.length === 0) return "";

  const domestic = topLocations.filter((l) =>
    isDomesticCity(
      l.city || "",
      l.country,
      storeCountry || undefined,
      currency || undefined,
      topLocations
    )
  );
  const international = topLocations.filter(
    (l) =>
      !isDomesticCity(
        l.city || "",
        l.country,
        storeCountry || undefined,
        currency || undefined,
        topLocations
      )
  );

  const domesticNames = domestic
    .map((d) => d.city)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
  const intlNames = international
    .map((i) => `${i.city}${i.country ? ` (${i.country})` : ""}`)
    .slice(0, 3)
    .join(", ");
  const intlPercentage = international.reduce(
    (sum, i) => sum + (i.percentage || 0),
    0
  );

  if (international.length > 0 && intlPercentage >= 5) {
    return `CROSS-BORDER & EXPORT BUYING DYNAMICS:
- Buyer Distribution: While the domestic core (${domesticNames || storeCountry || "Domestic"}) represents the primary foundation, real orders prove strong cross-border purchasing power from international markets (${intlNames}, accounting for ~${intlPercentage}% of customer demand).
- Cultural & Geographic Nuance: Frame the piece with cosmopolitan crossover appeal—grounded in the brand's authentic origin, heritage, and local craftsmanship, while highlighting effortless versatility, climate suitability, and international delivery confidence for global buyers.`;
  }

  if (domesticNames) {
    return `LOCALIZED CORE MARKET FOCUS:
- Buyer Distribution: Customer demand is strongly anchored in ${domesticNames}${storeCountry ? ` (${storeCountry})` : ""}.
- Cultural Nuance: Ground the tone, seasonal fit, and occasion styling deeply in authentic regional lifestyle patterns, local climate, and domestic purchasing habits without generic foreign tropes.`;
  }

  return "";
}

export interface ParsedBudgetReasoning {
  calibrationTitle?: string;
  calibrationBody?: string;
  recommendedPlan?: string;
  overseasExpansion?: string;
  cashFlowTip?: string;
  recentRevenueFormatted?: string;
  dipDailyFormatted?: string;
  isCashFlowConstrained?: boolean;
  rawFallback?: string;
}

/**
 * Parses dynamic multi-part budget reasoning into structured sections
 * for clean, founder-friendly rendering (zero walls of text, zero italics).
 */
export function parseBudgetReasoning(text: string): ParsedBudgetReasoning {
  if (!text) return {};

  let remaining = text.trim();
  const result: ParsedBudgetReasoning = {};

  // Extract Cash Flow Tip (e.g. 💡 Cash Flow Tip: ...)
  const cashFlowMatch = remaining.match(/💡\s*Cash Flow Tip:\s*([\s\S]+)$/i);
  if (cashFlowMatch) {
    result.cashFlowTip = cashFlowMatch[1].trim();
    result.isCashFlowConstrained = true;
    const revMatch = result.cashFlowTip.match(
      /recent 30-day store sales were\s+([^.]+?)(?:\.|$)/i
    );
    if (revMatch) {
      result.recentRevenueFormatted = revMatch[1].trim();
    }
    const dipMatch = result.cashFlowTip.match(
      /Dip Your Toe option \(([^)]+)\)/i
    );
    if (dipMatch) {
      result.dipDailyFormatted = dipMatch[1].trim();
    }
    remaining = remaining.substring(0, cashFlowMatch.index).trim();
  }

  // Extract Overseas Expansion (e.g. 💡 Optional Overseas Expansion: ...)
  const overseasMatch = remaining.match(/💡\s*Optional Overseas Expansion:\s*([\s\S]+)$/i);
  if (overseasMatch) {
    result.overseasExpansion = overseasMatch[1]
      .replace(/\)\./g, ".")
      .replace(/\s*\.\s*/g, ". ")
      .trim();
    remaining = remaining.substring(0, overseasMatch.index).trim();
  }

  // Extract Recommended Plan (e.g. Recommended Plan: ...)
  const planMatch = remaining.match(/Recommended Plan:\s*([\s\S]+)$/i);
  if (planMatch) {
    result.recommendedPlan = planMatch[1].trim();
    remaining = remaining.substring(0, planMatch.index).trim();
  }

  // Whatever remains is the calibration / core rationale
  if (remaining) {
    const calibColonMatch = remaining.match(
      /^(Calibrated for your product's [^:]+:|Scaled from your monthly store revenue of [^:]+:|Based on your product price point of [^:]+:)\s*([\s\S]+)$/i
    );
    if (calibColonMatch) {
      result.calibrationTitle = calibColonMatch[1].trim();
      result.calibrationBody = calibColonMatch[2].trim();
      const scaledRevMatch = calibColonMatch[1].match(
        /Scaled from your monthly store revenue of\s+([^:]+)/i
      );
      if (scaledRevMatch && !result.recentRevenueFormatted) {
        result.recentRevenueFormatted = scaledRevMatch[1].trim();
      }
    } else if (
      result.recommendedPlan ||
      result.overseasExpansion ||
      result.cashFlowTip
    ) {
      result.calibrationBody = remaining.trim();
    } else {
      result.rawFallback = remaining.trim();
    }
  }

  // If nothing was categorized, fall back to raw
  if (
    !result.calibrationBody &&
    !result.calibrationTitle &&
    !result.recommendedPlan &&
    !result.overseasExpansion &&
    !result.cashFlowTip &&
    !result.rawFallback
  ) {
    result.rawFallback = text.trim();
  }

  return result;
}
