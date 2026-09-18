import { describe, it, expect } from "vitest";
import { buildBriefPdfPayload, buildBriefText } from "@/lib/campaigns/brief";
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

describe("buildBriefHTML tests", () => {
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
      "46 of 49 unique customers (94%) who purchased this item were first-time customers of your store (based on lifetime store order history)."
    );
    expect(html).toContain(
      "Try a 9:16 vertical video (Instagram Reels &amp; Stories) showing the product in motion on a real person, paired with a clean square photo for feed placements."
    );
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
    expect(html).toContain("8–12 Add to Carts");
    expect(html).toContain("Target ad cost: under ~30% of item price");
    expect(html).toContain("Money Made − Ad Spend − Making the Product − Delivery − Card Fees = Real Profit in Your Pocket");
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
      "46 of 49 unique customers (94%) who purchased this item were first-time customers of your store (based on lifetime store order history)."
    );
  });

  it("renders Monthly Revenue Allocation and NO cash flow warning for healthy stores with adequate revenue", async () => {
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
    expect(html).toContain("Monthly Revenue Allocation");
    expect(html).toContain("₦3,000,000 verified over latest 30 days");
    expect(html).not.toContain("Cash Flow Advisory");
    expect(html).not.toContain("If cash is tight right now");
  });

  it("dynamically adjusts cart checkpoint to 15–20 for accessible items and displays verified order history peak days", async () => {
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
    expect(html).toContain("15–20 Add to Carts");
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
    // Card 8 intro rule
    expect(html).toContain("Rule #1: Give it 3 full days before touching anything");

    // Green Light scaling & profit check
    expect(html).toContain("🟢 It's Working · Profitable Orders");
    expect(html).toContain("Founder Profit Check");
    expect(html).toContain("at least 3–5 steady orders");
    expect(html).toContain("~20% every 3 to 4 days");

    // Yellow Light friction checks & benchmark
    expect(html).toContain("🟡 High Carts, Low Orders");
    expect(html).toContain("8–12 Add to Carts, but few or no orders");
    expect(html).toContain("typical cart checkout rates are 10–20%");
    expect(html).toContain("Surprise delivery fees");

    // Red Light 3-4 days spend range & action
    expect(html).toContain("🔴 Low Clicks / Refresh Hook");
    expect(html).toContain("After 3–4 days (₦42,681–₦56,908 spent): Link CTR &lt; 0.6% &amp; 0 carts");
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
});

