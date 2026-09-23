import { describe, it, expect } from "vitest";
import {
  buildBriefPdfPayload,
  buildBriefText,
  rescaleDailyBudgetForDuration,
} from "@/lib/campaigns/brief";
import { buildBriefHTML } from "@/lib/brief-html-template";
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
  it("preserves the test-spend envelope when duration changes", () => {
    expect(rescaleDailyBudgetForDuration(20, 14, 7)).toBe(40);
    expect(rescaleDailyBudgetForDuration(20, 14, 28)).toBe(10);
  });

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
      "Purchase"
    );
    expect(payload.advantage_plus_guidance?.event_evidence?.meta_event_status).toBe("unverified");
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
    expect(payload.budget.recommended_daily).toBe(20);
    expect(payload.budget.goal_adjusted_daily).toBe(60);
    expect(payload.budget.goal_label).toBe("grow brand awareness");
    expect(payload.copy.cta).toBe("Shop Now");
  });

  it("builds productUrl without inventing creative hooks when none were generated", () => {
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
    expect(payload.creative_hooks).toEqual([]);
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

  it("keeps local and overseas daily budgets independent and unscaled when 7-day duration is chosen", () => {
    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: baseInsights(1),
      storeInsights: null,
      selectedDuration: 7,
      selectedStrategyIndex: 1, // Balanced (20)
      selectedIntlStrategyIndex: 2, // Full Send (40)
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.budget.recommended_duration_days).toBe(7);
    expect(payload.budget.recommended_daily).toBe(20);
    expect(payload.budget.goal_adjusted_daily).toBe(40); // 20 * 2 ad sets
    expect(payload.budget.international_daily).toBe(40); // Full Send
    expect(payload.budget.international_tier).toBe("Full Send");
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
    expect(text).toContain("Optimization Event: Purchase");
    expect(text).toContain("confirm the Purchase event is active");
    expect(text).toContain("Suggested Age: 25 — 45");
    expect(text).toContain("Suggested Gender: Women");
    expect(text).toContain("Suggested Interests (AI Starting Hints): Fashion, Shopping");
    expect(text).toContain("Strategy: Balanced");
    expect(text).toContain("Ad Sets: 2");
    expect(text).toContain(`Recommended Daily: ${formatCurrency(40, "USD")}/day`);
    expect(text).toContain("Best days: Friday, Saturday");
  });

  it("includes independent overseas strategy and combined spend in brief text", () => {
    const text = buildBriefText({
      generatedCopy: copy,
      selectedCta: "Buy Now",
      aiInsights: baseInsights(1),
      storeInsights: {
        orders: { peak_days: ["Friday"] },
        store: { currency: "USD" },
      },
      goal: "Drive Website Sales",
      selectedStrategyIndex: 1, // Balanced (20) * 2 ad sets = 40/day
      selectedIntlStrategyIndex: 2, // Full Send (40/day)
      selectedDuration: 7,
    });

    expect(text).toContain("Strategy: Balanced");
    expect(text).toContain(`Recommended Daily: ${formatCurrency(40, "USD")}/day`);
    expect(text).toContain(`Total Test Spend: ${formatCurrency(280, "USD")}`); // 40 * 7
    expect(text).toContain("Optional Overseas Strategy: Full Send");
    expect(text).toContain(`Optional Overseas Daily: ${formatCurrency(40, "USD")}/day`);
    expect(text).toContain(`Optional Overseas Test Spend: ${formatCurrency(280, "USD")} (1 separate ad set)`);
    expect(text).toContain(`Combined Total Daily: ${formatCurrency(80, "USD")}/day`);
    expect(text).toContain(`Combined Total Test Spend: ${formatCurrency(560, "USD")} (7 days)`);
  });
});

describe("buildBriefHTML tests", () => {
  it("shows observed storefront funnel and flags the Meta event as unverified", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Tee",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: baseInsights(),
      storeInsights: {
        orders: { orders_last_30_days: 80 },
        prespend: {
          granted_scopes: ["read_reports"],
          missing_required_scopes: [],
          capabilities: {},
          markets: [],
          shipping_zones: [],
          fulfillment_locations: [],
          active_discounts: [],
          marketing_history: [],
          policies: [],
          locales: [],
          analytics: {
            source: "shopifyql",
            window_days: 90,
            sessions: null,
            visitors: null,
            sessions_with_cart_additions: null,
            sessions_that_reached_checkout: null,
            sessions_that_completed_checkout: null,
            added_to_cart_rate: null,
            checkout_conversion_rate: null,
            conversion_rate: null,
            gross_sales: null,
            discounts: null,
            returns: null,
            net_sales: null,
            shipping_charges: null,
            taxes: null,
            total_sales: null,
            order_count: null,
            average_order_value: null,
            top_countries: [],
            recent_funnel: {
              source: "shopifyql_sessions",
              window_days: 30,
              sessions: 400,
              cart_sessions: 50,
              checkout_sessions: 25,
              completed_checkout_sessions: 12,
              checkout_conversion_rate: 0.48,
            },
          },
        },
      },
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(payload.advantage_plus_guidance?.optimization_event).toBe("Purchase");
    expect(html).toContain("Shopify 30-day sessions: 50 cart additions, 25 reached checkout, 12 completed checkout");
    expect(html).toContain("Shopify sessions do not verify Meta event health");
    expect(html).toContain("confirm the Purchase event is active");
  });

  it("never includes the redundant 'Before you launch' checklist card", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        warnings: ["91 products out of stock"],
      },
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).not.toContain("Before you launch");
  });

  it("synchronizes product price in budget reasoning text", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants (Matcha)",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
          reasoning:
            "Calibrated for your product's ₦230,000 price point: Higher-value pieces take more browsing before shoppers buy.",
        },
      },
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("Calibrated for your product's ₦120,000 price point:");
    expect(html).not.toContain("Calibrated for your product's ₦230,000 price point:");
  });

  it("separates proven store orders and AI-recommended expansion hubs in Card 04", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
        },
        targeting: {
          ...baseInsights(1).targeting!,
          international_locations: [
            { name: "London", source: "from_data" },
            { name: "New York", source: "recommended" },
            { name: "Houston", source: "recommended" },
          ],
        },
      },
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("Proven by past store orders");
    expect(html).toContain("Based on past customer shipments in your Shopify store.");
    expect(html).toContain("Suggested expansion markets (AI recommendation)");
    expect(html).toContain("Major international commercial and diaspora centers");
  });

  it("separates proven local store orders and AI-recommended local hubs in Card 04", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
        },
        targeting: {
          ...baseInsights(1).targeting!,
          domestic_locations: [
            { name: "Lagos", source: "from_data" },
            { name: "Abuja", source: "recommended" },
            { name: "Port Harcourt", source: "recommended" },
          ],
        },
      },
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("Proven by past store orders");
    expect(html).toContain("Based on past customer shipments in your Shopify store.");
    expect(html).toContain("Suggested regional hubs (AI recommendation)");
    expect(html).toContain("Commercial centers to test based on urban reach and delivery access.");
  });

  it("renders strong first-purchase signal with exact customer counts and lifetime context", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: baseInsights(1),
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: {
        currentProductClassification: "Gateway",
        currentProductName: "Ego Pants",
        currentProductImage: "",
        bestsellerName: "Ego Pants",
        topGatewayName: "Ego Pants",
        isBestsellerGateway: true,
        currentProductVelocity: 5,
        currentProductRepeatRate: 0.1,
        storeAov: 230000,
        storeBaseFtb: 0.6,
        firstTimeBuyerRatio: 0.94,
        firstTimeBuyerCount: 46,
        uniqueCustomerCount: 49,
        unitsSold: 49,
      },
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("✓ Strong first-purchase signal:");
    expect(html).toContain(
      "46 of 49 unique customers (94%) who purchased this item were first-time customers of your store (based on accessible paid-order history)."
    );
    expect(html).toContain(
      "Try a 9:16 vertical video (Instagram Reels &amp; Stories) showing the product in motion on a real person, paired with a clean square photo for feed placements."
    );
  });

  it("shows first-order role and stock hold as separate, sourced decisions in the brief", async () => {
    const productDecision = {
      logic_version: 1 as const,
      source: "shopify_accessible_paid_orders_and_catalog" as const,
      as_of: "2026-09-22T00:00:00.000Z",
      role: "Gateway" as const,
      role_confidence: "directional" as const,
      first_order_count: 8,
      identified_first_orders: 12,
      first_order_reach: 0.6667,
      later_order_count: 1,
      identified_later_orders: 12,
      later_order_reach: 0.0833,
      role_reason: "8 of 12 identified first orders contained this product, compared with 1 of 12 later orders.",
      follow_up_60d: { eligible_first_order_buyers: 8, buyers_with_another_order: 3, repeat_rate: 0.375 },
      test_readiness: "hold" as const,
      readiness_reasons: ["No catalog variant currently shows positive stock."],
      limitations: ["First means first accessible paid order."],
    };
    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Ego Pants",
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: baseInsights(),
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: {
        currentProductClassification: "Gateway",
        currentProductName: "Ego Pants",
        productDecision,
      },
      isNewLaunch: false,
    });
    const html = await buildBriefHTML(payload);
    expect(html).toContain("Possible First-Order Gateway");
    expect(html).toContain("8 of 12 identified first orders");
    expect(html).toContain("3 of 8 buyers placed another store order");
    expect(html).toContain("Hold the ad test until stock returns");
    expect(html).toContain("Shopify accessible paid orders and catalog, synced 2026-09-22");
  });

  it("matches Page 1 flight deck and Page 4 audience locations without 3-city truncation", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
        },
        targeting: {
          ...baseInsights(1).targeting!,
          domestic_locations: [
            { name: "Lagos", source: "from_data" },
            { name: "Abuja", source: "recommended" },
            { name: "Port Harcourt", source: "recommended" },
            { name: "Ibadan", source: "recommended" },
          ],
        },
      },
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    // Page 1 flight deck control panel
    expect(html).toContain("Lagos, Abuja, Port Harcourt, Ibadan");
  });

  it("renders transparent budget calculation breakdown table and creative angles to test", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
          recommended_daily: 14238,
          reasoning:
            "Calibrated for your product's ₦120,000 price point: Higher-value pieces take more browsing before shoppers buy. Recommended Plan: 1 consolidated ad set at ₦14,238/day focused on your primary domestic market.\n\n💡 Cash Flow Tip: Your recent 30-day store sales were ₦253,250. If cash flow is tight, choose the Dip Your Toe option (₦9,967/day) to test with less risk.",
        },
      },
      storeInsights: null,
      selectedDuration: 7,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("Transparent Budget Calculation Breakdown");
    expect(html).toContain("Store Sales Context");
    expect(html).toContain("₦253,250");
    expect(html).toContain("How Budget Was Chosen");
    expect(html).toContain("Starter Testing Baseline");
    expect(html).toContain("Cash Flow Advisory");
    expect(html).toContain("Recommended Test (Sweet Spot)");
    expect(html).toContain("Lower-Spend Option (Dip Your Toe)");
    expect(html).toContain("3 Creative angles to test");
    expect(html).toContain("Suggested starting age");
    expect(html).toContain("Strong interest: shoppers adding to cart, but drop-offs before checkout");
    expect(html).toContain("Target ad spend per sale");
    expect(html).toContain("Founder Profit Check: Money Made − Ad Spend − Product Cost − Delivery − Payment Fees = Real Cash in Pocket");
    expect(html).not.toContain("TikTok");
  });

  it("dynamically calculates local USD equivalent in ad account currency tip", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
          ad_sets: 1,
          recommended_daily: 14238,
          strategies: [
            { label: "Dip Your Toe", daily: 9967, total_daily: 9967, description: "" },
            { label: "Sweet Spot", daily: 14238, total_daily: 14238, description: "" },
            { label: "Scale Fast", daily: 21357, total_daily: 21357, description: "" },
          ],
        },
      },
      storeInsights: null,
      selectedDuration: 7,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("Ad Account Currency Tip");
    expect(html).toContain(
      "enter <strong>~$9/day USD</strong> for your primary local campaign (equivalent to ₦14,238/day)"
    );
    expect(html).not.toContain("enter $18/day USD directly in Ads Manager");
  });

  it("derives first-time buyer count from ratio when explicit count is missing in gateway insight", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: baseInsights(1),
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: {
        topGatewayName: "Ego Pants",
        isBestsellerGateway: true,
        currentProductVelocity: 5,
        currentProductRepeatRate: 0.1,
        storeAov: 230000,
        storeBaseFtb: 0.6,
        firstTimeBuyerRatio: 0.94,
        uniqueCustomerCount: 49,
      },
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("✓ Strong first-purchase signal:");
    expect(html).toContain(
      "46 of 49 unique customers (94%) who purchased this item were first-time customers of your store (based on accessible paid-order history)."
    );
  });

  it("renders the revenue-tier rule and no cash flow warning for healthy stores with adequate revenue", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "Acme Apparel",
      productName: "Basic Tee",
      productPrice: 20000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
          ad_sets: 1,
          recommended_daily: 10000,
          breakdown: {
            revenue_based: 3000000,
          },
          reasoning:
            "Scaled from your store's regular monthly sales: Allocates a disciplined ~5–10% testing budget (₦3,000,000 baseline).",
        },
      },
      storeInsights: null,
      selectedDuration: 14,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("Revenue-Tier Testing Rule");
    expect(html).toContain("₦3,000,000 verified over latest 30 days");
    expect(html).not.toContain("Cash Flow Advisory");
    expect(html).not.toContain("If cash is tight right now");
  });

  it("uses a store-specific or explicitly unavailable cart baseline and displays verified order history peak days", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "Acme",
      productName: "Beanie",
      productPrice: 35,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: baseInsights(1),
      storeInsights: {
        orders: { peak_days: ["Monday", "Friday", "Sunday"] },
      },
      selectedDuration: 7,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    expect(html).toContain("Strong interest: shoppers adding to cart, but drop-offs before checkout");
    expect(html).toContain("Peak buying days (from your Shopify orders)");
    expect(html).toContain(
      "✓ Based on order history: Shoppers placed the most orders on Monday, Friday, Sunday. Past order timing reflects historical customer activity, not an algorithmic guarantee of future ad performance."
    );
  });

  it("formats headlines with proper word spacing and separates concatenated words", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants (Noir)",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: {
        headline: "An ElasticWaist That FitsWithout Fuss",
        primaryText: "Engineered for pure comfort.",
        description: "Premium tailored trousers.",
        cta: "Shop Now",
        copywriterNote: "Strategic rationale for test",
      },
      selectedCta: "Shop Now",
      aiInsights: baseInsights(1),
      storeInsights: null,
      selectedDuration: 7,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    // Verifies regex separation of camelCase/concatenated words in headline
    expect(html).toContain("An Elastic Waist That Fits Without Fuss");
    // Verifies CSS contains standard word spacing and safe letter-spacing
    expect(html).toContain("letter-spacing:-0.01em;");
    expect(html).toContain("word-spacing:normal;");
  });

  it("renders founder-friendly Yellow Light friction checks and Red Light testing spend range", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
          ad_sets: 1,
          recommended_daily: 14227,
          strategies: [
            { label: "Dip Your Toe", daily: 9959, total_daily: 9959, description: "" },
            { label: "Sweet Spot", daily: 14227, total_daily: 14227, description: "" },
            { label: "Full Send", daily: 19918, total_daily: 19918, description: "" },
          ],
        },
      },
      storeInsights: null,
      selectedDuration: 7,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    // Card 8 uses budget-relative checkpoints rather than generic day counts.
    expect(html).toContain("Founder Rule: Give Meta 48–72 hours before making changes");

    // Green Light scaling & profit check
    expect(html).toContain("🟢 It's Working · Profitable Orders");
    expect(html).toContain("Founder Profit Check");
    expect(html).toContain("Verify net profit");

    // Yellow Light friction checks & benchmark
    expect(html).toContain("🟡 High Carts, Low Orders");
    expect(html).toContain("Strong interest: shoppers adding to cart, but drop-offs before checkout");
    expect(html).toContain("Surprise delivery fees");

    // Red Light 3-4 days spend range & action
    expect(html).toContain("🔴 Low Clicks / Refresh Hook");
    expect(html).toContain("At 50% of test budget (₦49,795 spent): link CTR &lt; 0.8% and few page visits");
    expect(html).toContain("Don't start over or delete your campaign");
  });

  it("resolves launch schedule consistency and ensures explanation matches recommended day", async () => {
    const payload = buildBriefPdfPayload({
      brandName: "K | KASA",
      productName: "Ego Pants",
      productPrice: 120000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: {
        ...baseInsights(1),
        budget: {
          ...baseInsights(1).budget!,
          currency: "NGN",
          currency_symbol: "₦",
        },
        timing: {
          peak_days: ["Monday", "Friday"],
          launch_recommendation:
            "Schedule your campaign to start at midnight Lagos time on a Sunday to give Meta a full cycle.",
          reasoning: "Order data shows Monday is strongest.",
        },
      },
      storeInsights: null,
      selectedDuration: 7,
      selectedStrategyIndex: 1,
      gatewayInsight: null,
      isNewLaunch: false,
    });

    const html = await buildBriefHTML(payload);
    // Verifies Monday launch timing without Sunday contradiction
    expect(html).toContain("Recommended launch time:</strong> Monday, 12:00 AM (Lagos time)");
    expect(html).toContain("12:00 AM (midnight Lagos time) as Monday begins");
    expect(html).not.toContain("on a Sunday");
  });

  it("handles independent duration timelines for Primary Local and Overseas markets cleanly", async () => {
    const customInsights: AiInsights = {
      ...baseInsights(1),
      budget: {
        currency: "NGN",
        currency_symbol: "₦",
        recommended_daily: 28466,
        recommended_duration_days: 14,
        tier: "Sweet Spot",
        reasoning: "Test budget for local and overseas.",
        strategies: [
          { label: "Dip Your Toe", daily: 14233, total_daily: 14233, description: "" },
          { label: "Sweet Spot", daily: 28466, total_daily: 28466, description: "" },
          { label: "Full Send", daily: 56932, total_daily: 56932, description: "" },
        ],
        international_strategies: [
          { label: "Dip Your Toe", daily: 26568, total_daily: 26568, description: "" },
          { label: "Sweet Spot", daily: 39851, total_daily: 39851, description: "" },
          { label: "Full Send", daily: 53135, total_daily: 53135, description: "" },
        ],
      },
      targeting: {
        locations: [{ name: "Lagos, Nigeria", country: "Nigeria", market_type: "domestic" }],
        international_locations: [{ name: "London, United Kingdom", country: "United Kingdom", market_type: "international" }],
      },
    };

    const payload = buildBriefPdfPayload({
      brandName: "Acme Nigeria",
      productName: "Silk Shirt",
      productPrice: 45000,
      goal: "Drive Website Sales",
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: customInsights,
      storeInsights: {
        store: { country: "NG", currency: "NGN" },
      },
      selectedDuration: 14,
      selectedIntlDuration: 7,
      selectedStrategyIndex: 1, // Sweet Spot: 28466
      selectedIntlStrategyIndex: 2, // Full Send: 53135
      gatewayInsight: null,
      isNewLaunch: false,
    });

    expect(payload.budget.recommended_duration_days).toBe(14);
    expect(payload.budget.international_duration_days).toBe(7);
    expect(payload.budget.recommended_daily).toBe(28466);
    expect(payload.budget.international_daily).toBe(53135);

    // Plain-text brief check
    const briefText = buildBriefText({
      generatedCopy: copy,
      selectedCta: "Shop Now",
      aiInsights: customInsights,
      storeInsights: {
        store: { country: "NG", currency: "NGN" },
      },
      goal: "Drive Website Sales",
      selectedStrategyIndex: 1,
      selectedIntlStrategyIndex: 2,
      selectedDuration: 14,
      selectedIntlDuration: 7,
      gatewayInsight: null,
    });

    expect(briefText).toContain("Test Duration: 14 days");
    expect(briefText).toContain("Total Test Spend: ₦398,524");
    expect(briefText).toContain("Optional Overseas Strategy: Full Send");
    expect(briefText).toContain("Optional Overseas Test Duration: 7 days");
    expect(briefText).toContain("Optional Overseas Test Spend: ₦371,945 (1 separate ad set)");
    expect(briefText).toContain("Combined Total Daily: ₦81,601/day");
    expect(briefText).toContain("Combined Total Test Spend: ₦770,469 (Local 14d + Overseas 7d)");

    // HTML / PDF template check
    const html = await buildBriefHTML(payload);
    expect(html).toContain("Local 14d + Overseas 7d: ₦770,469");
    expect(html).toContain('<span class="row-label">Test Duration</span><span class="row-value">14 days</span>');
    expect(html).toContain('<span class="row-label">Total Test Spend</span><span class="row-value">₦398,524</span>');
    expect(html).toContain('<span class="row-label">Optional Duration</span><span class="row-value">7 days</span>');
    expect(html).toContain('<span class="row-label">Estimated Test Spend</span><span class="row-value">₦371,945</span>');
    expect(html).toContain("Local: ₦398,524 (14d) + Overseas: ₦371,945 (7d) = Total ₦770,469");
  });
});
