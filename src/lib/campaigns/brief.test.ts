import { describe, it, expect } from "vitest";
import { buildBriefPdfPayload, buildBriefText } from "@/lib/campaigns/brief";
import { formatCurrency } from "@/lib/currency";
import type {
  AiInsights,
  GeneratedCopy,
  StoreInsights,
} from "@/components/campaigns/types";

const copy: GeneratedCopy = {
  headline: "Big Sale",
  primaryText: "Shop the collection now.",
  description: "Premium everyday wear.",
  cta: "Shop Now",
  copywriterNote: "Lead with value.",
};

/** AiInsights fixture with Advantage+ guidance, creative hooks, and budget strategies. */
function baseInsights(
  goalMult = 1,
  goalKey = "Drive Website Sales"
): AiInsights {
  return {
    creative_hooks: [
      {
        angle: "Problem / Friction",
        visual_cue: "Close up of fabric fraying vs this durable build",
        on_screen_text: "Tired of clothes that shrink?",
        primary_text_hook: "Most daily tees give out in 3 washes. Here's why ours doesn't.",
      },
      {
        angle: "Identity / Status",
        visual_cue: "Lifestyle street shot in London",
        on_screen_text: "Quiet luxury for every day.",
        primary_text_hook: "Designed for those who want quality without screaming logos.",
      },
      {
        angle: "Material / Craftsmanship",
        visual_cue: "Macro detail of heavyweight organic cotton",
        on_screen_text: "280 GSM heavyweight cotton.",
        primary_text_hook: "Feel the difference of true heavyweight organic cotton.",
      },
    ],
    advantage_plus_guidance: {
      campaign_type: "Manual Sales with Advantage+ Audience",
      optimization_event: "InitiateCheckout",
      optimization_reasoning:
        "Moderate volume detected. Optimizing for InitiateCheckout provides enough event frequency.",
      seed_audience_suggestions: {
        age_min: 25,
        age_max: 45,
        gender: "Women",
        demographic_justification: "Matches store purchasing history.",
        seed_interests: ["Fashion", "Shopping"],
      },
    },
    targeting: {
      locations: [{ name: "Lagos" }, { name: "Abuja" }],
      age_min: 25,
      age_max: 45,
      gender: "Women",
      interests: ["Fashion", "Shopping"],
    },
    budget: {
      currency: "USD",
      reasoning: "Start moderate.",
      ad_sets: 2,
      recommended_daily: 20,
      optimization_event: { event: "InitiateCheckout", reasoning: "Best signal." },
      breakdown: { goal_multipliers: { [goalKey]: goalMult } },
      strategies: [
        { label: "Conservative", daily: 10, total_daily: 20, description: "" },
        { label: "Balanced", daily: 20, total_daily: 40, description: "" },
        { label: "Aggressive", daily: 40, total_daily: 80, description: "" },
      ],
    },
  };
}

describe("buildBriefPdfPayload", () => {
  it("computes recommended/goal-adjusted daily, tier, creative hooks, and advantage_plus_guidance", () => {
    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Buy Now",
      aiInsights: baseInsights(1),
      storeInsights: {
        orders: { orders_last_30_days: 45 },
      },
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.budget.recommended_daily).toBe(20);
    expect(payload.budget.goal_adjusted_daily).toBe(40);
    expect(payload.budget.tier).toBe("Balanced");
    expect(payload.budget.goal_label).toBeUndefined();
    expect(payload.budget.reasoning).toBe("Start moderate.");
    expect(payload.copy.cta).toBe("Buy Now");
    expect(payload.creative_hooks?.length).toBe(3);
    expect(payload.creative_hooks?.[0].angle).toBe("Problem / Friction");
    expect(payload.advantage_plus_guidance?.campaign_type).toBe(
      "Manual Sales with Advantage+ Audience"
    );
    expect(payload.advantage_plus_guidance?.optimization_event).toBe(
      "InitiateCheckout"
    );
    expect(payload.implementation_steps?.length).toBe(3);
  });

  it("rewrites the budget reasoning and sets goal_label when a multiplier applies", () => {
    const insights = baseInsights(1.5, "Grow Brand Awareness");
    insights.budget!.reasoning = `Spend ${formatCurrency(20, "USD")}/day to start.`;

    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Grow Brand Awareness",
      generatedCopy: copy,
      selectedCta: "",
      aiInsights: insights,
      storeInsights: null,
      selectedDuration: 7,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.budget.reasoning).toBe(
      `Spend ${formatCurrency(30, "USD")}/day to start.`
    );
    expect(payload.budget.goal_adjusted_daily).toBe(60);
    expect(payload.budget.goal_label).toBe("grow brand awareness");
    expect(payload.copy.cta).toBe("Shop Now");
  });

  it("builds productUrl from the store domain and matching product handle", () => {
    const storeInsights: StoreInsights = {
      store: { domain: "shop.example.com" },
      products: [{ id: "1", name: "Tee", handle: "classic-tee" }],
    };

    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: null,
      storeInsights,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: true,
    });

    expect(payload.productUrl).toBe(
      "https://shop.example.com/products/classic-tee"
    );
    expect(payload.isNewLaunch).toBe(true);
    expect(payload.creative_hooks?.length).toBe(3);
  });

  it("appends the limited-data warning and preserves existing warnings", () => {
    const aiInsights: AiInsights = { warnings: ["Existing warning"] };
    const storeInsights: StoreInsights = {
      orders: { order_count: 5 },
      products: [
        { id: "1", name: "Tee", description: "short", tags: ["a"], order_count: 1 },
      ],
    };

    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights,
      storeInsights,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.warnings).toEqual([
      "Existing warning",
      "Limited product data detected — review seed suggestions before launching.",
    ]);
  });

  it("dynamically formats selected international budget based on selectedIntlStrategyIndex", () => {
    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: baseInsights(1),
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      selectedIntlStrategyIndex: 2, // Full Send
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.budget.international_daily).toBe(40);
    expect(payload.budget.international_tier).toBe("Full Send");
    expect(payload.budget.international_budget_formatted).toBe("$40/day");
    expect(payload.targeting?.international_budget_formatted).toBe("$40/day");
  });
});

describe("buildBriefText", () => {
  it("assembles the brief text with creative hooks and Advantage+ guidance", () => {
    const text = buildBriefText({
      generatedCopy: copy,
      selectedCta: "Buy Now",
      aiInsights: baseInsights(1),
      storeInsights: {
        orders: { peak_days: ["Friday", "Saturday"] },
        store: { currency: "USD" },
      },
      goal: "Drive Website Sales",
      selectedStrategyIndex: 1,
      selectedDuration: 14,
    });

    expect(text).toContain("HEADLINE:\nBig Sale");
    expect(text).toContain("CTA: Buy Now");
    expect(text).toContain("── CREATIVE HOOKS (ADVANTAGE+) ──");
    expect(text).toContain("Hook 1 [Problem / Friction]:");
    expect(text).toContain("── TARGET AUDIENCE & CAMPAIGN SETTINGS ──");
    expect(text).toContain("Campaign Type: Manual Sales with Advantage+ Audience");
    expect(text).toContain("Optimization Event: InitiateCheckout");
    expect(text).toContain("Suggested Age: 25 — 45");
    expect(text).toContain("Suggested Gender: Women");
    expect(text).toContain("Suggested Interests (AI Starting Hints): Fashion, Shopping");
    expect(text).toContain("Strategy: Balanced");
    expect(text).toContain("Ad Sets: 2");
    expect(text).toContain(`Recommended Daily: ${formatCurrency(40, "USD")}/day`);
    expect(text).toContain("Best days: Friday, Saturday");
  });
});
