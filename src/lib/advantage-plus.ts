import type { StoreRecentFunnel } from "./store-data";

export type CampaignType =
  | "Advantage+ Shopping Campaign (ASC)"
  | "Manual Sales with Advantage+ Audience";

export type OptimizationEvent = "AddToCart" | "InitiateCheckout" | "Purchase";

export interface EventPlanningEvidence {
  source: "shopifyql_sessions" | "shopify_paid_orders_only" | "unavailable";
  meta_event_status: "unverified";
  recent_funnel: StoreRecentFunnel | null;
  conditional_alternative: {
    event: "InitiateCheckout" | "AddToCart";
    condition: string;
  } | null;
}

export interface AdvantagePlusGuidanceResult {
  campaign_type: CampaignType;
  optimization_event: OptimizationEvent;
  default_reasoning: string;
  event_evidence: EventPlanningEvidence;
}

/**
 * A pre-spend event hypothesis. Shopify sessions describe storefront behavior;
 * only Meta Events Manager can verify that an optimization event is usable.
 * Paid-order volume never selects a shallower event or campaign architecture.
 */
export function getAdvantagePlusGuidance(
  monthlyOrders: number,
  recentFunnel?: StoreRecentFunnel | null,
): AdvantagePlusGuidanceResult {
  const metrics = recentFunnel && [
    recentFunnel.cart_sessions,
    recentFunnel.checkout_sessions,
    recentFunnel.completed_checkout_sessions,
  ].every((value) => value !== null && Number.isFinite(value) && value >= 0);
  const observed = metrics ? recentFunnel! : null;
  const source: EventPlanningEvidence["source"] = observed
    ? "shopifyql_sessions"
    : monthlyOrders > 0 ? "shopify_paid_orders_only" : "unavailable";
  const observedText = observed
    ? `In the last ${observed.window_days} days, Shopify recorded ${observed.cart_sessions!.toLocaleString()} online-store sessions with a cart addition, ${observed.checkout_sessions!.toLocaleString()} that reached checkout, and ${observed.completed_checkout_sessions!.toLocaleString()} that completed checkout. These are store sessions, not Meta events.`
    : monthlyOrders > 0
      ? `Shopify recorded ${monthlyOrders.toLocaleString()} paid orders in the last 30 days, but that total does not establish website or Meta event volume.`
      : "Recent Shopify website funnel data is unavailable; event volume cannot be estimated.";

  let conditionalAlternative: EventPlanningEvidence["conditional_alternative"] = null;
  if (observed && observed.checkout_sessions! > observed.completed_checkout_sessions!) {
    conditionalAlternative = {
      event: "InitiateCheckout",
      condition: "If measured Meta Purchase events prove too sparse for this test, review Initiate Checkout only after confirming that it fires correctly in Events Manager and checkout traffic leads to purchases.",
    };
  } else if (observed && observed.cart_sessions! > observed.completed_checkout_sessions!) {
    conditionalAlternative = {
      event: "AddToCart",
      condition: "If measured Meta Purchase events prove too sparse for this test, review Add to Cart only after confirming that it fires correctly in Events Manager and cart traffic leads to purchases.",
    };
  }

  return {
    campaign_type: "Manual Sales with Advantage+ Audience",
    optimization_event: "Purchase",
    default_reasoning: `${observedText} Purchase best matches the goal of acquiring buyers, so it is the starting hypothesis, not a verified Meta setting. Before publishing, confirm the Purchase event is active and receiving recent website events in Meta Events Manager.${conditionalAlternative ? ` ${conditionalAlternative.condition}` : ""}`,
    event_evidence: {
      source,
      meta_event_status: "unverified",
      recent_funnel: observed,
      conditional_alternative: conditionalAlternative,
    },
  };
}
