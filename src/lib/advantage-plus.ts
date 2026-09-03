export type CampaignType =
  | "Advantage+ Shopping Campaign (ASC)"
  | "Manual Sales with Advantage+ Audience";

export type OptimizationEvent = "AddToCart" | "InitiateCheckout" | "Purchase";

export interface AdvantagePlusGuidanceResult {
  campaign_type: CampaignType;
  optimization_event: OptimizationEvent;
  default_reasoning: string;
}

/**
 * Deterministically routes campaign type and optimization event based on
 * monthly completed orders from Shopify (as a proxy for pixel signal density).
 */
export function getAdvantagePlusGuidance(
  monthlyOrders: number
): AdvantagePlusGuidanceResult {
  // High volume: Enough conversion density for ASC + Purchase (~20+ orders/week)
  if (monthlyOrders >= 80) {
    return {
      campaign_type: "Advantage+ Shopping Campaign (ASC)",
      optimization_event: "Purchase",
      default_reasoning:
        "With strong monthly sales, optimizing directly for Purchases allows Meta to find buyers ready to check out immediately.",
    };
  }

  // Mid volume: Bridge stage to prevent learning limited state
  if (monthlyOrders >= 30) {
    return {
      campaign_type: "Manual Sales with Advantage+ Audience",
      optimization_event: "InitiateCheckout",
      default_reasoning:
        "With steady monthly sales, optimizing for Initiate Checkout gives Meta plenty of data to find buyers quickly.",
    };
  }

  // Low volume / High AOV: Concentrate sparse signals
  return {
    campaign_type: "Manual Sales with Advantage+ Audience",
    optimization_event: "AddToCart",
    default_reasoning:
      "With current order volume, optimizing for Add to Cart helps Meta learn who wants your product much faster than waiting for purchases.",
  };
}
