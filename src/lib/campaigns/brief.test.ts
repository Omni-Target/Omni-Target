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

/** AiInsights fixture with three budget strategies and a single goal multiplier. */
function baseInsights(
  goalMult = 1,
  goalKey = "Drive Website Sales",
): AiInsights {
  return {
    targeting: {
      locations: [{ name: "Lagos" }, { name: "Abuja" }],
      age_min: 25,
      age_max: 45,
      gender: "Female",
      interests: ["Fashion", "Shopping"],
      behaviours: ["Engaged Shoppers"],
    },
    budget: {
      currency: "USD",
      reasoning: "Start moderate.",
      ad_sets: 2,
      recommended_daily: 20,
      optimization_event: { event: "Purchase", reasoning: "Best signal." },
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
  it("computes recommended/goal-adjusted daily, tier, and label (multiplier = 1)", () => {
    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Buy Now",
      aiInsights: baseInsights(1),
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.budget.recommended_daily).toBe(20); // strategies[1].daily
    expect(payload.budget.goal_adjusted_daily).toBe(40); // round(20 * 2 * 1)
    expect(payload.budget.tier).toBe("Balanced");
    expect(payload.budget.goal_label).toBeUndefined(); // multiplier is 1
    expect(payload.budget.reasoning).toBe("Start moderate."); // unchanged
    expect(payload.copy.cta).toBe("Buy Now"); // selectedCta wins
    expect(payload.gatewayInsight).toBeUndefined();
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

    // adjustedPerAdSet = round(20 * 1.5) = 30 → "$20" rewritten to "$30".
    expect(payload.budget.reasoning).toBe(
      `Spend ${formatCurrency(30, "USD")}/day to start.`,
    );
    expect(payload.budget.goal_adjusted_daily).toBe(60); // round(20 * 2 * 1.5)
    expect(payload.budget.goal_label).toBe("grow brand awareness");
    expect(payload.copy.cta).toBe("Shop Now"); // empty selectedCta → fallback
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
      "https://shop.example.com/products/classic-tee",
    );
    expect(payload.isNewLaunch).toBe(true);
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
      "Limited product data detected — review interests before launching.",
    ]);
  });

  it("does not append the limited-data warning when product data is sufficient", () => {
    const storeInsights: StoreInsights = {
      orders: { order_count: 50 },
      products: [
        {
          id: "1",
          name: "Tee",
          description: "A".repeat(40),
          tags: ["a", "b", "c"],
          order_count: 25,
        },
      ],
    };

    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: { warnings: [] },
      storeInsights,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.warnings).toEqual([]);
  });

  it("leaves budget figures undefined when no AI insights are present", () => {
    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: null,
      storeInsights: null,
      selectedDuration: 30,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.budget.recommended_daily).toBeUndefined();
    expect(payload.budget.goal_adjusted_daily).toBeUndefined();
    expect(payload.budget.recommended_duration_days).toBe(30);
    expect(typeof payload.generatedAt).toBe("string");
  });
});

describe("buildBriefText", () => {
  it("assembles the brief text with computed budget figures", () => {
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
    expect(text).toContain("Locations: Lagos, Abuja");
    expect(text).toContain("Age: 25 — 45");
    expect(text).toContain("Gender: Female");
    expect(text).toContain("Interests: Fashion, Shopping");
    expect(text).toContain("Strategy: Balanced");
    expect(text).toContain("Ad Sets: 2");
    expect(text).toContain(`Recommended Daily: ${formatCurrency(40, "USD")}/day`);
    expect(text).toContain("Test Duration: 14 days");
    expect(text).toContain(`Total Test Spend: ${formatCurrency(40 * 14, "USD")}`);
    expect(text).toContain("Best days: Friday, Saturday");
  });

  it("uses manual-setup fallbacks when no AI insights are present", () => {
    const text = buildBriefText({
      generatedCopy: copy,
      selectedCta: "",
      aiInsights: null,
      storeInsights: { store: { currency: "USD" } },
      goal: "Drive Website Sales",
      selectedStrategyIndex: 1,
      selectedDuration: 14,
    });

    expect(text).toContain("CTA: Shop Now"); // empty selectedCta → fallback
    expect(text).toContain("Locations: Set manually");
    expect(text).toContain("Age: 25 — 44");
    expect(text).toContain("Gender: All");
    expect(text).toContain("Behaviours: Engaged Shoppers");
    expect(text).toContain(
      `Recommended starting budget: ${formatCurrency(5000, "USD")}/day for 14 days`,
    );
    expect(text).toContain("Set final budget in Meta Ads Manager");
    expect(text).toContain("No timing data yet");
  });
});
