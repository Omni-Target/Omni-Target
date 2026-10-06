import { describe, expect, it } from "vitest";
import { getAdvantagePlusGuidance } from "./advantage-plus";
import type { StoreRecentFunnel } from "./store-data";

const observedFunnel: StoreRecentFunnel = {
  source: "shopifyql_sessions",
  window_days: 30,
  sessions: 400,
  cart_sessions: 50,
  checkout_sessions: 25,
  completed_checkout_sessions: 12,
  checkout_conversion_rate: 0.48,
};

describe("getAdvantagePlusGuidance", () => {
  it.each([0, 29, 30, 79, 80, 100])(
    "does not infer a Meta optimization event from %i Shopify orders",
    (monthlyOrders) => {
      const result = getAdvantagePlusGuidance(monthlyOrders);
      expect(result.optimization_event).toBe("Purchase");
      expect(result.campaign_type).toBe("Manual Sales with Advantage+ Audience");
      expect(result.event_evidence.meta_event_status).toBe("unverified");
      expect(result.event_evidence.conditional_alternative).toBeNull();
      expect(result.default_reasoning).toContain("Meta Events Manager");
      expect(result.default_reasoning).not.toMatch(/20.*week|signal density/i);
    },
  );

  it("uses observed Shopify sessions as storefront evidence, not verified Meta events", () => {
    const result = getAdvantagePlusGuidance(80, observedFunnel);
    expect(result.event_evidence.source).toBe("shopifyql_sessions");
    expect(result.event_evidence.recent_funnel).toEqual(observedFunnel);
    expect(result.default_reasoning).toContain("50 online-store sessions with a cart addition");
    expect(result.default_reasoning).toContain("not Meta events");
    expect(result.event_evidence.conditional_alternative?.event).toBe("InitiateCheckout");
    expect(result.event_evidence.conditional_alternative?.condition).toContain("If measured Meta Purchase events prove too sparse");
  });

  it("falls back when a funnel count is missing", () => {
    const result = getAdvantagePlusGuidance(12, {
      ...observedFunnel,
      checkout_sessions: null,
    });
    expect(result.event_evidence.source).toBe("shopify_paid_orders_only");
    expect(result.event_evidence.recent_funnel).toBeNull();
    expect(result.event_evidence.conditional_alternative).toBeNull();
    expect(result.default_reasoning).toContain("does not establish website or Meta event volume");
  });

  it("only considers cart when no larger checkout pool is observed", () => {
    const result = getAdvantagePlusGuidance(2, {
      ...observedFunnel,
      checkout_sessions: 12,
    });
    expect(result.event_evidence.conditional_alternative?.event).toBe("AddToCart");
  });
});
