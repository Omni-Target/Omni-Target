import { StoreData, StoreProduct } from "./store-data";
import Anthropic from "@anthropic-ai/sdk";
import { formatCurrency } from "@/lib/currency";
import { fetchExchangeRates } from "./exchange-rates";
import { getAdvantagePlusGuidance } from "./advantage-plus";
import {
  isDomesticCity,
  getEffectiveStoreCountry,
  getInternationalStrategies,
  getInternationalBudgetFloor,
  isTier1Market,
} from "./market-geography";
import type {
  CreativeHook,
  AdvantagePlusGuidance,
} from "./brief-pdf-types";
import {
  validateBrief,
  sanitizeLeakedTokens,
  type TargetProductContext,
  type CatalogItem,
  type GeneratedBriefResponse,
} from "./validate-brief";

const anthropicClient = new Anthropic();
import { logApiUsage } from "@/lib/db";

export interface LocationResult {
  name: string;
  source: "from_data" | "recommended";
  percentage?: number | null;
  note?: string;
  country?: string;
  market_type?: "domestic" | "international";
}

export interface TimingOutput {
  peak_days: string[];
  launch_recommendation: string;
  reasoning: string;
}

export interface TargetingProfile {
  locations: LocationResult[];
  demographics: {
    gender: "All" | "Men" | "Women";
    demographic_justification: string;
    age_min: number;
    age_max: number;
    age_reasoning: string;
  };
  seed_interests: string[];
  creative_hooks: CreativeHook[];
  optimization_reasoning: string;
  timing: TimingOutput;
}

/**
 * ─── 1. Consolidate AI Calls (Single-Pass Intelligence) ───
 * Makes a single call to Anthropic's Message API using structured tool use
 * to determine Meta Advantage+ creative hooks, seed audience, and timing.
 */
export async function generateTargetingProfile(
  storeData: StoreData,
  adSets: number,
  dailyBudget: number,
  userId?: string | null,
  targetProductOverride?: StoreProduct
): Promise<TargetingProfile> {
  const storeCurrency = storeData.store?.currency || "USD";
  const monthlyOrders =
    storeData.orders.orders_last_30_days || storeData.orders.order_count || 0;
  const guidance = getAdvantagePlusGuidance(monthlyOrders);

  // Format top locations
  const consolidatedLocations = storeData.orders.top_locations
    .map((l) => `${l.city} (${l.percentage}%)`)
    .join(", ");

  // Identify target single product
  const targetProduct =
    targetProductOverride ||
    (storeData.products && storeData.products.length > 0
      ? [...storeData.products].sort(
          (a, b) => (b.revenue || 0) - (a.revenue || 0)
        )[0]
      : {
          id: "default-product",
          name: storeData.store.name || "Main Collection Item",
          price: Math.round(storeData.orders.average_order_value || 50),
          units_sold: 10,
          revenue: 500,
          product_type: "General",
          collection: "General",
          description: "",
          tags: ["bestseller"],
        });

  const targetProductCtx: TargetProductContext = {
    id: (targetProduct as { id?: string }).id || targetProduct.name,
    title: targetProduct.name,
    tags: targetProduct.tags,
    product_type:
      targetProduct.product_type ||
      (targetProduct as { collection?: string }).collection,
    price: targetProduct.price,
    url: (targetProduct as { url?: string }).url,
  };

  const catalog: CatalogItem[] = (storeData.products || []).map((p) => ({
    id: (p as { id?: string }).id || p.name,
    title: p.name,
  }));

  const targetProductTitle = targetProduct.name;
  const targetProductDescription =
    targetProduct.description || "None provided";
  const targetProductType =
    targetProduct.product_type ||
    (targetProduct as { collection?: string }).collection ||
    "General";
  const targetProductTags =
    (targetProduct.tags || []).join(", ") || "None";
  const targetProductPrice =
    targetProduct.price ||
    Math.round(storeData.orders.average_order_value || 0);
  const targetProductUrl =
    (targetProduct as { url?: string }).url ||
    `https://${storeData.store.domain || "store.com"}`;
  const storeName = storeData.store.name;
  const storeCountry = getEffectiveStoreCountry(
    storeData.store.country,
    storeData.store.currency,
    storeData.orders.top_locations
  );
  const isTier1 = isTier1Market(storeCountry, storeCurrency);
  const hasOverseasBuyers = storeData.orders.top_locations.some(
    (l) => !isDomesticCity(l.city || "", l.country, storeCountry, storeCurrency, storeData.orders.top_locations)
  );
  const aov = Math.round(storeData.orders.average_order_value);
  const peakDaysStr =
    storeData.orders.peak_days.length > 0
      ? storeData.orders.peak_days.join(", ")
      : "None recorded yet";

  // Build the sibling deny-list from catalog (all products except the target)
  const siblingDenyList = catalog
    .filter(
      (c) =>
        c.id !== targetProductCtx.id &&
        c.title.trim().toLowerCase() !== targetProductCtx.title.trim().toLowerCase()
    )
    .map((c) => `  - "${c.title}"`)
    .join("\n");

  const systemPrompt = `You are a senior Meta Ads media buyer briefing a busy e-commerce founder on a single-product Advantage+ campaign.

Where Meta actually is right now (do not contradict this):
Meta removed most detailed-targeting interest categories on January 15, 2026. Any interest or demographic input you give Meta's Ads Manager is a "seed suggestion" for cold-start delivery — not a hard filter, and not something the algorithm is bound to respect once it has real conversion signal. Location, minimum age, and language are the only hard constraints left. Manual behavioral tags (e.g. "Engaged Shoppers," "Frequent Travelers") still exist as selectable options in Detailed Targeting, but do NOT output them in this brief. Under the Advantage+ Audience architecture, behavioral tags are soft suggestions, and on-platform buying signal is already factored in automatically. Stick strictly to the seed_interests field; leave behaviors out entirely.
This means creative — the hook, the visual, the on-screen text — is doing 100% of the targeting work interests used to do. Everything you write must be built on that reality.

Creative hook taxonomy — pick exactly 3 angles, all different:
- Problem / Friction — resolves a specific physical friction or annoyance
- Identity / Status — signals who the buyer is or wants to be seen as
- Material / Craftsmanship — tactile quality, construction, premium finish
- Usability / Transformation — before/after, real-world wear, ease of styling
- Contrarian / Curiosity — challenges a category assumption, sparks a stop-scroll question
- Offer / Risk Reversal — guarantee, early access, low-friction entry

Before finalizing your answer, perform a mandatory self-check: if two hooks make a similar argument to the same buyer persona, replace one. All 3 hooks must use distinct psychological frames with zero conceptual overlap.

Tone & Merchant Phrasing (CRITICAL: Simple Plain English):
Write like you're advising a busy e-commerce founder in simple, human English. Maximum one sentence per reasoning/note/justification field.
NEVER use corporate or technical jargon like "architecture", "signal volume", "exit the learning phase", "starving the algorithm", "CPM imbalance", "acquisition signal", "behavioral velocity", "cohort signals", "seed mechanisms", or "catalog role".
Lead with clear, practical advice that anyone can understand immediately.`;

  const prompt = `Scope: STRICT SINGLE-SKU ISOLATION
You are writing a brief for exactly one product: ${targetProductTitle}.
Product Description: ${targetProductDescription}
You have NOT been given the rest of the store's catalog, on purpose. Every visual cue, on-screen text, and primary text hook must describe ${targetProductTitle} and its specific details (${targetProductDescription}) and nothing else — no other garment, set, or SKU, named or implied. If you describe "the drape of X" or "styled in Y" where X or Y is not ${targetProductTitle}, you are hallucinating sibling catalog items. Describe ONLY the target product's specific materials, cut, texture, fit, or utility as described in its product details.
${siblingDenyList ? `\nFORBIDDEN: These other store products MUST NEVER appear by name or be referenced in any hook field:\n${siblingDenyList}\nIf any of the above names appear in your output — even partially — the brief will be rejected.` : ""}

Seed Audience Suggestions, Gender & Location Strategy (CRITICAL)
${
  isTier1
    ? `- ADVANTAGE+ LOCATION STRATEGY FOR ${storeCountry.toUpperCase()}:
  - Primary Domestic Market:
    * In Meta Advantage+, nationwide broad targeting (${storeCountry} Nationwide) is the gold standard for maximum algorithmic liquidity and lowest CPMs.
    * If the store has order data in specific metro hubs (e.g. New York, Los Angeles, Chicago, Houston, Atlanta), include 3–5 of them as top buyer signals (source: "from_data" if present, else "recommended"), but advise broad nationwide targeting in Meta Ads Manager.
  - International Export Market:
    ${
      hasOverseasBuyers
        ? `* The store has recorded overseas buyers in order data. Include only those real international cities (source: "from_data").`
        : `* The store operates primarily domestically. Do NOT invent or output international cities. Leave international locations empty so the founder stays 100% focused on their home market.`
    }`
    : `- DUAL-MARKET METROPOLITAN TARGETING (${storeCountry.toUpperCase()}):
  - Primary Local Market (3–5 domestic cities):
    * Prioritize real buying cities within ${storeCountry} from actual order data (source: "from_data").
    * In addition, dynamically infer 1–2 complementary commercial hubs or regional economic centres within ${storeCountry} whose local demographic and disposable income best match a ${targetProductPrice} ${storeCurrency} price point (source: "recommended"). Reason about the product category, occasion, and purchasing power — do not blindly repeat a static list.
  - International Export & Diaspora Market (2–4 international cities):
    * If the store has recorded overseas buyers, include them (source: "from_data").
    * In addition, dynamically infer 2–3 international cities with proven diaspora concentration, expatriate demand, or export purchasing power specifically for ${targetProductTitle} (${targetProductType || "Apparel"}) at ${targetProductPrice} ${storeCurrency} (source: "recommended"). Tailor your selections to where buyers of this specific aesthetic and price point actually reside.`
}
  - Each location item must include a concise, plain-English note explaining why it's a top buying hub for this store/product.
- Gender Selection:
  - If the product is specifically for women (e.g. dresses, skirts, mini slips, robes, bras, heels, women's co-ords, women's lingerie/fashion), you MUST select gender: "Women".
  - If the product is specifically for men (e.g. men's suits, boxer briefs, men's shorts, trunks), you MUST select gender: "Men".
  - Only select gender: "All" if the product is genuinely unisex or universal.
- In demographic_justification, write 1 simple sentence explaining the gender selection and purchasing power fit.
- Select 3–5 broad category interests (always include "Online Shopping"). Avoid competitor names or niche interest stacking.

Store & Product Context
Target Product: ${targetProductTitle}
Product Description: ${targetProductDescription}
Category: ${targetProductType}
Tags: ${targetProductTags}
Price: ${targetProductPrice} ${storeCurrency}
Product URL: ${targetProductUrl}
Store: ${storeName}, ${storeCountry}
Rolling 60-day AOV: ${aov} ${storeCurrency}
Monthly Orders: ${monthlyOrders}
Assigned Campaign Architecture: ${guidance.campaign_type}
Assigned Optimization Event: ${guidance.optimization_event}
Top Buyer Locations: ${consolidatedLocations || "None recorded yet"}
Peak Order Days: ${peakDaysStr}

Creative hooks: exactly 3 distinct angles dynamically inferred from ${targetProductTitle}'s attributes, price point (${aov} ${storeCurrency}), and buyer mindset:
  - If the product features tactile fabric, handmade detailing (e.g. beading, embroidery, artisan construction), or premium materials: select "Material / Craftsmanship" to establish quality and justify price.
  - If the product solves a dressing hassle, fit friction, or comfort frustration (e.g. elasticated waist, no zip struggle, easy slip-on, versatile styling): select "Usability / Transformation" to highlight effortless daily wear.
  - If the product has a unique design feature that defies convention or sparks intrigue (e.g. "Why does this dress need no zip?"): select "Contrarian / Curiosity" to stop the feed scroll.
  - For entry-level gateway products or everyday staples: select "Problem / Friction" (fixing frustrations with ordinary clothes) or "Identity / Status" (personal aesthetic and confidence).
  Ensure all 3 angles represent fundamentally DIFFERENT psychological reasons to buy so Meta's Advantage+ machine learning can dynamically match each angle to different shopper mindsets. Keep on-screen text under 8 words.
Demographics: gender matched to product type ("Women", "Men", or "All") and age range fitted to price point; 1-sentence justification in plain English.
Seed interests: 3–5 broad category items (must include "Online Shopping").
Locations: Recommend 3–5 high-converting domestic cities in ${storeCountry} (combining order data with inferred commercial hubs), plus 2–4 strategic international cities with strong buyer affinity. Mark each from_data or recommended.
Optimization reasoning: 1 simple sentence in plain English explaining why optimizing for ${guidance.optimization_event} is best for this store's volume of ${monthlyOrders} orders/month.
Timing (Plain English & Practical):
  - launch_recommendation: 1 dynamic sentence advising the founder to schedule the campaign to go live at 12:00 AM (midnight) or early morning in their store's timezone leading into ${peakDaysStr} so Meta has a clean full day to pace the daily budget smoothly.
  - reasoning: 1 dynamic sentence reassuring the founder to keep ads running 24/7 without pausing, explaining that Meta builds shopper interest all week and automatically drives the most sales during their peak days of ${peakDaysStr}.
Call generate_advantage_plus_profile with the complete payload.`;

  const advantagePlusTool: Anthropic.Tool = {
    name: "generate_advantage_plus_profile",
    description:
      "Single-SKU Meta Advantage+ campaign brief: creative hooks, seed audience, timing.",
    cache_control: { type: "ephemeral" },
    input_schema: {
      type: "object",
      properties: {
        target_product_title: {
          type: "string",
          description:
            "Echo the exact target product title back — used by the validator to confirm no drift.",
        },
        locations: {
          type: "array",
          minItems: 2,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "Specific high-converting city or metro area (e.g. 'Lagos', 'Abuja', 'Greater London', 'New York'). Never whole countries.",
              },
              country: {
                type: "string",
                description: "The country where this city is located.",
              },
              market_type: {
                type: "string",
                enum: ["domestic", "international"],
                description:
                  "Whether this city is in the store's primary local market ('domestic') or an export/diaspora market abroad ('international').",
              },
              source: {
                type: "string",
                enum: ["from_data", "recommended"],
              },
              percentage: { type: ["number", "null"] },
              note: { type: "string" },
            },
            required: ["name", "source", "percentage", "note"],
          },
        },
        demographics: {
          type: "object",
          properties: {
            gender: {
              type: "string",
              enum: ["All", "Men", "Women"],
            },
            demographic_justification: { type: "string" },
            age_min: { type: "number", minimum: 18 },
            age_max: { type: "number" },
            age_reasoning: { type: "string" },
          },
          required: [
            "gender",
            "demographic_justification",
            "age_min",
            "age_max",
            "age_reasoning",
          ],
        },
        seed_interests: {
          type: "array",
          minItems: 3,
          maxItems: 5,
          items: { type: "string" },
        },
        creative_hooks: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              angle: {
                type: "string",
                enum: [
                  "Problem / Friction",
                  "Identity / Status",
                  "Material / Craftsmanship",
                  "Usability / Transformation",
                  "Contrarian / Curiosity",
                  "Offer / Risk Reversal",
                ],
              },
              visual_cue: { type: "string" },
              on_screen_text: { type: "string" },
              primary_text_hook: { type: "string" },
            },
            required: [
              "angle",
              "visual_cue",
              "on_screen_text",
              "primary_text_hook",
            ],
          },
        },
        optimization_reasoning: { type: "string" },
        timing: {
          type: "object",
          properties: {
            peak_days: {
              type: "array",
              items: { type: "string" },
            },
            launch_recommendation: { type: "string" },
            reasoning: { type: "string" },
          },
          required: ["peak_days", "launch_recommendation", "reasoning"],
        },
      },
      required: [
        "target_product_title",
        "locations",
        "demographics",
        "seed_interests",
        "creative_hooks",
        "optimization_reasoning",
        "timing",
      ],
    },
  };

  try {
    const response = await anthropicClient.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1800,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: prompt }],
      tools: [advantagePlusTool],
      tool_choice: {
        type: "tool",
        name: "generate_advantage_plus_profile",
      },
    });

    const toolUseBlock = response.content.find((c) => c.type === "tool_use");
    if (toolUseBlock && toolUseBlock.type === "tool_use") {
      let profile = toolUseBlock.input as GeneratedBriefResponse;

      if (userId) {
        logApiUsage(
          userId,
          "targeting_profile",
          response.usage.input_tokens,
          response.usage.output_tokens
        );
      }

      // Code-Side Deterministic Validator
      let validationErrors = validateBrief(
        profile,
        targetProductCtx,
        catalog
      );

      if (validationErrors.length > 0) {
        console.warn(
          "[Advantage+ Validator] Initial validation failed:",
          validationErrors
        );

        // Single automatic retry with temperature adjustment (0.2)
        try {
          const retryResponse = await anthropicClient.messages.create({
            model: "claude-sonnet-5",
            max_tokens: 1800,
            temperature: 0.2,
            system: [
              {
                type: "text",
                text: systemPrompt,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: [
              { role: "user", content: prompt },
              { role: "assistant", content: response.content },
              {
                role: "user",
                content: `The generated brief failed validation with the following error(s):\n${validationErrors
                  .map((e) => `- ${e}`)
                  .join(
                    "\n"
                  )}\n\nPlease regenerate the profile strictly addressing these errors. Ensure exactly 3 distinct angles, zero references to sibling catalog items, and describe only "${targetProductTitle}".`,
              },
            ],
            tools: [advantagePlusTool],
            tool_choice: {
              type: "tool",
              name: "generate_advantage_plus_profile",
            },
          });

          const retryToolBlock = retryResponse.content.find(
            (c) => c.type === "tool_use"
          );
          if (retryToolBlock && retryToolBlock.type === "tool_use") {
            profile = retryToolBlock.input as GeneratedBriefResponse;
            validationErrors = validateBrief(
              profile,
              targetProductCtx,
              catalog
            );
          }
        } catch (retryErr) {
          console.error("[Advantage+ Validator] Retry failed:", retryErr);
        }

        // If still invalid after retry, sanitize flagged tokens and log alert
        if (validationErrors.length > 0) {
          console.error(
            "[Advantage+ Validator Alert] Brief failed validation after retry:",
            validationErrors
          );
          profile = sanitizeLeakedTokens(
            profile,
            targetProductCtx,
            catalog
          );
        }
      }

      if (
        profile &&
        profile.locations &&
        profile.demographics &&
        Array.isArray(profile.creative_hooks) &&
        profile.creative_hooks.length > 0 &&
        profile.timing
      ) {
        return {
          locations: profile.locations,
          demographics: {
            gender: profile.demographics.gender || "All",
            demographic_justification:
              profile.demographics.demographic_justification ||
              "Demographic profile aligned with product price point and buyer history.",
            age_min: profile.demographics.age_min || 25,
            age_max: profile.demographics.age_max || 44,
            age_reasoning:
              profile.demographics.age_reasoning ||
              "Age range structured for core buyer purchasing power.",
          },
          seed_interests: Array.isArray(profile.seed_interests)
            ? profile.seed_interests
            : ["Online Shopping", "Fashion"],
          creative_hooks: profile.creative_hooks.slice(0, 3),
          optimization_reasoning:
            profile.optimization_reasoning || guidance.default_reasoning,
          timing: profile.timing,
        };
      }
    }
  } catch (err) {
    console.error("AI Advantage+ profile generation error:", err);
  }

  // Fallback defaults in case of API failure or tool parsing error
  const defaultLocations =
    storeData.orders.top_locations.length > 0
      ? storeData.orders.top_locations.map((l) => ({
          name: l.city,
          source: "from_data" as const,
          percentage: l.percentage,
          note: `Top buyer hub representing ${l.percentage}% of your customer orders.`,
        }))
      : [
          {
            name: storeData.store.country || "Lagos",
            source: "from_data" as const,
            percentage: 100,
            note: "Defaulting targeting to your store's home market.",
          },
        ];

  const brand = storeData.store.name || "our collection";

  return {
    locations: defaultLocations,
    demographics: {
      gender: "All",
      demographic_justification:
        "Starting with broad gender targeting gives Meta's Advantage+ algorithm maximum liquidity to find buyers.",
      age_min: 25,
      age_max: 44,
      age_reasoning:
        "Standard e-commerce age targeting (25-44) is recommended for early validation campaigns.",
    },
    seed_interests: ["Online Shopping", "Fashion"],
    creative_hooks: [
      {
        angle: "Problem / Friction",
        visual_cue:
          "Close-up demonstration showing common frustration resolved by product",
        on_screen_text: "Stop settling for ordinary.",
        primary_text_hook: `Tired of standard options that don't hold up? Here is what makes ${brand} different.`,
      },
      {
        angle: "Identity / Status",
        visual_cue:
          "Lifestyle shot showing product in a natural, elevated everyday setting",
        on_screen_text: "Engineered for daily wear.",
        primary_text_hook: `Designed for people who appreciate thoughtful details and timeless style.`,
      },
      {
        angle: "Material / Craftsmanship",
        visual_cue:
          "Macro detail shot highlighting texture, stitching, and finish quality",
        on_screen_text: "Built with premium craft.",
        primary_text_hook: `Every piece is built to feel better and last longer from day one.`,
      },
    ],
    optimization_reasoning: guidance.default_reasoning,
    timing: {
      peak_days:
        storeData.orders.peak_days.length > 0
          ? storeData.orders.peak_days
          : ["Thursday"],
      launch_recommendation:
        storeData.orders.peak_days.length > 0
          ? `Launch on ${storeData.orders.peak_days[0]} morning to ride the buying momentum.`
          : "Launch on Thursday evening to capture weekend traffic.",
      reasoning:
        storeData.orders.peak_days.length > 0
          ? `Order data shows a clear conversion lift on ${storeData.orders.peak_days.join(", ")}.`
          : "Thursday launches build optimal momentum for weekend e-commerce traffic.",
    },
  };
}

// ─── Health Scoring Functions ───

function scoreProducts(products: StoreData["products"]): {
  score: number;
  max: number;
  status: "good" | "warning" | "bad";
} {
  const raw = Math.min(products.length / 20, 1) * 20;
  const score = Math.round(raw);
  return {
    score,
    max: 20,
    status:
      products.length >= 10 ? "good" : products.length >= 5 ? "warning" : "bad",
  };
}

function scoreOrders(orderCount: number): {
  score: number;
  max: number;
  status: "good" | "warning" | "bad";
} {
  const raw = Math.min(orderCount / 30, 1) * 30;
  const score = Math.round(raw);
  return {
    score,
    max: 30,
    status: orderCount >= 20 ? "good" : orderCount >= 5 ? "warning" : "bad",
  };
}

function scoreRetention(repeatRate: number): {
  score: number;
  max: number;
  status: "good" | "warning" | "bad";
} {
  const score = Math.round(repeatRate * 25);
  return {
    score,
    max: 25,
    status: repeatRate > 0.3 ? "good" : repeatRate > 0.1 ? "warning" : "bad",
  };
}

function scoreAvailability(products: StoreData["products"]): {
  score: number;
  max: number;
  status: "good" | "warning" | "bad";
} {
  if (products.length === 0) return { score: 0, max: 25, status: "bad" };
  const ratio = products.filter((p) => p.in_stock).length / products.length;
  const score = Math.round(ratio * 25);
  return {
    score,
    max: 25,
    status: ratio > 0.8 ? "good" : ratio > 0.5 ? "warning" : "bad",
  };
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface MetaRecommendations {
  lowDataWarning?: boolean;
  lowDataMessage?: string;
  newStoreCaution?: boolean;
  newStoreCautionMessage?: string;
  highBudgetWarning?: boolean;
  highBudgetWarningMessage?: string;
  budgetWarning?: boolean;
  budgetWarningMessage?: string;
  creative_hooks: CreativeHook[];
  advantage_plus_guidance: AdvantagePlusGuidance;
  targeting: {
    locations: LocationResult[];
    domestic_locations?: LocationResult[];
    international_locations?: LocationResult[];
    domestic_budget_formatted?: string;
    international_budget_formatted?: string;
    overseas_demand?: string[];
    age_min: number;
    age_max: number;
    age_reasoning: string;
    gender: "All" | "Men" | "Women" | "all" | "female" | "male";
    gender_reasoning?: string;
    interests: string[];
    interest_reasoning?: string;
    behaviours?: string[];
  };
  budget: {
    recommended_daily: number;
    recommended_duration_days: number;
    reasoning: string;
    currency: string;
    currency_symbol?: string;
    tier: "Starter" | "Testing" | "Growth" | "Scale";
    breakdown: {
      revenue_based: number;
      aov_based: number;
      goal_multipliers: Record<string, number>;
      meta_optimal_daily: number;
    };
    ad_sets: number;
    ad_set_reasoning?: string;
    optimization_event: {
      event: string;
      reasoning: string;
      target_weekly: number;
      upgrade_milestone?: string;
    };
    strategies: {
      label: string;
      daily: number;
      total_daily: number;
      description: string;
    }[];
    international_strategies?: {
      label: string;
      daily: number;
      total_daily: number;
      description: string;
    }[];
    international_recommended_daily?: number;
  };
  timing: TimingOutput;
  placements: {
    recommended: string[];
  };
  top_products_to_advertise: string[];
  products_to_avoid: string[];
  store_health_score: number;
  health_breakdown: {
    label: string;
    score: number;
    max: number;
    status: "good" | "warning" | "bad";
    percentage: number;
  }[];
  warnings: string[];
  opportunities: string[];
}

// ─── Main Engine ──────────────────────────────────────────────────────────────

export async function generateRecommendations(
  storeData: StoreData,
  dynamicExchangeRates?: Record<string, number>,
  userId?: string | null,
  targetProductOverride?: StoreProduct
): Promise<MetaRecommendations> {
  const storeCurrency = storeData.store.currency || "USD";
  const rates = dynamicExchangeRates || (await fetchExchangeRates());
  const exchangeRate = rates[storeCurrency] || 1;
  const monthlyOrders =
    storeData.orders.orders_last_30_days || storeData.orders.order_count || 0;
  const guidance = getAdvantagePlusGuidance(monthlyOrders);

  // ─── Before running calculations: data sufficiency check ───
  if (storeData.orders.order_count < 20) {
    const brand = storeData.store.name || "our collection";
    const defaultHooks: CreativeHook[] = [
      {
        angle: "Problem / Friction",
        visual_cue:
          "Close-up demonstration showing common frustration resolved by product",
        on_screen_text: "Stop settling for ordinary.",
        primary_text_hook: `Tired of standard options that don't hold up? Here is what makes ${brand} different.`,
      },
      {
        angle: "Identity / Status",
        visual_cue:
          "Lifestyle shot showing product in a natural, elevated everyday setting",
        on_screen_text: "Engineered for daily wear.",
        primary_text_hook: `Designed for people who appreciate thoughtful details and timeless style.`,
      },
      {
        angle: "Material / Craftsmanship",
        visual_cue:
          "Macro detail shot highlighting texture, stitching, and finish quality",
        on_screen_text: "Built with premium craft.",
        primary_text_hook: `Every piece is built to feel better and last longer from day one.`,
      },
    ];

    const lowDataCatalogPrices = (storeData.products || [])
      .map((p) => p.price)
      .filter((p): p is number => typeof p === "number" && p > 0)
      .sort((a, b) => a - b);
    const lowDataMedianCatalogPrice =
      lowDataCatalogPrices.length > 0
        ? lowDataCatalogPrices[Math.floor(lowDataCatalogPrices.length / 2)]
        : 0;
    const effectiveLowDataAov =
      (targetProductOverride?.price && targetProductOverride.price > 0)
        ? targetProductOverride.price
        : storeData.orders.average_order_value > 0
        ? storeData.orders.average_order_value
        : lowDataMedianCatalogPrice > 0
        ? lowDataMedianCatalogPrice
        : 25 * exchangeRate;

    return {
      lowDataWarning: true,
      lowDataMessage:
        "We need at least 20 orders to generate reliable recommendations. Keep selling and check back soon.",
      creative_hooks: defaultHooks,
      advantage_plus_guidance: {
        campaign_type: guidance.campaign_type,
        optimization_event: guidance.optimization_event,
        optimization_reasoning: guidance.default_reasoning,
        seed_audience_suggestions: {
          age_min: 25,
          age_max: 44,
          gender: "All",
          demographic_justification:
            "Starting with broad demographics gives Meta's Advantage+ algorithm maximum flexibility.",
          seed_interests: ["Online Shopping", "Fashion"],
        },
      },
      targeting: {
        locations:
          storeData.orders.top_locations.length > 0
            ? storeData.orders.top_locations.map((l) => ({
                name: l.city,
                source: "from_data" as const,
                percentage: l.percentage,
                note: `Top buyer city representing ${l.percentage}% of your customer orders.`,
              }))
            : [
                {
                  name: storeData.store.country || "Lagos",
                  source: "from_data" as const,
                  percentage: 100,
                  note: "Defaulting targeting to your store's home market.",
                },
              ],
        age_min: 25,
        age_max: 44,
        age_reasoning: "We need at least 20 orders to infer target age range.",
        gender: "All",
        gender_reasoning:
          "We recommend starting with broad gender targeting to let Meta's pixel learn your buyer profile.",
        interests: ["Online Shopping", "Fashion"],
        interest_reasoning:
          "Starting with broad interest seed hints is recommended for stores with low order volume.",
      },
      budget: {
        recommended_daily: Math.round(15 * exchangeRate),
        recommended_duration_days: 14,
        reasoning:
          "Starter testing budget: 1 consolidated ad set focused on your primary domestic market to jumpstart conversions and build initial pixel data.",
        currency: storeCurrency,
        currency_symbol: storeData.store.currency_symbol || "$",
        tier: "Starter",
        ad_sets: 1,
        optimization_event: {
          event: guidance.optimization_event,
          reasoning: guidance.default_reasoning,
          target_weekly: 10,
        },
        breakdown: {
          revenue_based: 0,
          aov_based: Math.round(effectiveLowDataAov),
          goal_multipliers: {
            "Drive Website Sales": 1.0,
            "Grow Brand Awareness": 0.6,
            "Promote a New Collection": 1.2,
            "Retarget Past Visitors": 0.4,
          },
          meta_optimal_daily: Math.round(15 * exchangeRate),
        },
        strategies: [
          {
            label: "Dip Your Toe",
            daily: Math.round(15 * exchangeRate * 0.7),
            total_daily: Math.round(15 * exchangeRate * 0.7),
            description:
              "Low risk, slow learning. Good if you're testing for the first time.",
          },
          {
            label: "Sweet Spot",
            daily: Math.round(15 * exchangeRate * 1.0),
            total_daily: Math.round(15 * exchangeRate * 1.0),
            description:
              "Our recommendation. Enough budget for Meta to learn without burning cash.",
          },
          {
            label: "Full Send",
            daily: Math.round(15 * exchangeRate * 1.4),
            total_daily: Math.round(15 * exchangeRate * 1.4),
            description:
              "Faster results but higher daily spend. Best when you already know your creative works.",
          },
        ],
        international_strategies: getInternationalStrategies(storeCurrency, exchangeRate),
        international_recommended_daily: Math.round(18 * exchangeRate),
      },
      timing: {
        peak_days: [],
        launch_recommendation:
          "Launch anytime — gather data from your first campaign to optimise timing",
        reasoning: "No peak day data yet",
      },
      placements: {
        recommended: [
          "Facebook Feed",
          "Instagram Feed",
          "Instagram Stories",
          "Instagram Reels",
        ],
      },
      top_products_to_advertise: storeData.products
        .filter((p) => p.should_advertise)
        .slice(0, 5)
        .map((p) => p.name),
      products_to_avoid: storeData.products
        .filter((p) => !p.should_advertise)
        .map((p) => p.name),
      store_health_score: 20,
      health_breakdown: [
        {
          label: "Active Products",
          score: 5,
          max: 20,
          status: "warning",
          percentage: 25,
        },
        {
          label: "Recent Orders",
          score: 5,
          max: 30,
          status: "bad",
          percentage: 16,
        },
        {
          label: "Customer Retention",
          score: 5,
          max: 25,
          status: "bad",
          percentage: 20,
        },
        {
          label: "Product Availability",
          score: 5,
          max: 25,
          status: "bad",
          percentage: 20,
        },
      ],
      warnings: [
        "We need at least 20 orders to generate reliable recommendations. Keep selling and check back soon.",
      ],
      opportunities: [],
    };
  }

  // --- Check new store caution ---
  let newStoreCaution = false;
  let newStoreCautionMessage: string | undefined;

  if (storeData.orders.oldest_order_date) {
    const oldestDate = new Date(storeData.orders.oldest_order_date);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    if (oldestDate > thirtyDaysAgo) {
      newStoreCaution = true;
      newStoreCautionMessage =
        "Your store is new — these recommendations will improve as more order data comes in.";
    }
  }

  const effectiveStoreCountry = getEffectiveStoreCountry(
    storeData.store?.country,
    storeData.store?.currency,
    storeData.orders.top_locations
  );

  // ── Multi-Market & Ad Sets Intelligence ──
  const isDomestic = (city: string, country: string | undefined) =>
    isDomesticCity(
      city,
      country,
      effectiveStoreCountry,
      storeData.store?.currency,
      storeData.orders.top_locations
    );

  // Categorize order locations into domestic vs international
  const domesticLocations = (storeData.orders.top_locations || []).filter((l) =>
    isDomestic(l.city, l.country)
  );

  const internationalLocations = (storeData.orders.top_locations || []).filter(
    (l) => !isDomestic(l.city, l.country)
  );

  const hasInternationalDemand = internationalLocations.length > 0;

  // ── BUDGET CALCULATION (USD tiered revenue ratio with AOV liquidity guardrail) ──
  const avgMonthlyRevenue =
    (storeData.orders as { revenue_avg_3_months?: number })
      .revenue_avg_3_months ||
    storeData.orders.revenue_last_30_days ||
    0;
  const avgMonthlyRevenueUSD = avgMonthlyRevenue / exchangeRate;

  const TEST_DURATION_DAYS = 14;

  let totalTestBudgetUSD = 150;
  let budgetTier: "Starter" | "Testing" | "Growth" | "Scale" = "Starter";

  if (avgMonthlyRevenueUSD < 2000) {
    totalTestBudgetUSD = 150;
    budgetTier = "Starter";
  } else if (avgMonthlyRevenueUSD <= 10000) {
    totalTestBudgetUSD = Math.min(avgMonthlyRevenueUSD * 0.12, 800);
    budgetTier = "Growth";
  } else {
    totalTestBudgetUSD = Math.min(avgMonthlyRevenueUSD * 0.07, 2000);
    budgetTier = "Scale";
  }

  const totalDailySpendUSD = totalTestBudgetUSD / TEST_DURATION_DAYS;

  // ── AOV & PRODUCT PRICE GUARDRAIL WATERFALL ──
  // Fallback hierarchy if store had a dry spell / low-to-no recent orders:
  // 1. Historical store AOV (from rolling 60d or lifetime orders)
  // 2. Target product price being advertised (if generating for a specific product)
  // 3. Median product price from store catalog
  // 4. Default testing baseline ($25)
  const catalogPrices = (storeData.products || [])
    .map((p) => p.price)
    .filter((p): p is number => typeof p === "number" && p > 0)
    .sort((a, b) => a - b);
  const medianCatalogPrice =
    catalogPrices.length > 0
      ? catalogPrices[Math.floor(catalogPrices.length / 2)]
      : 0;

  const effectiveAOV =
    (targetProductOverride?.price && targetProductOverride.price > 0)
      ? targetProductOverride.price
      : storeData.orders.average_order_value > 0
      ? storeData.orders.average_order_value
      : medianCatalogPrice > 0
      ? medianCatalogPrice
      : 25 * exchangeRate;

  const aovUSD = effectiveAOV / exchangeRate;
  const aovGuardrailUSD = aovUSD * 0.5;

  let finalDailyUSD: number;
  let budgetWarning = false;
  let budgetWarningMessage: string | undefined;

  if (aovGuardrailUSD > totalDailySpendUSD * 3) {
    finalDailyUSD = totalDailySpendUSD;
    budgetWarning = true;
    const guardrailLocal = Math.round(aovGuardrailUSD * exchangeRate);
    const tierLocal = Math.round(totalDailySpendUSD * exchangeRate);
    budgetWarningMessage = `Your product price point ideally requires ${storeData.store.currency_symbol || ""}${guardrailLocal.toLocaleString()}/day for Meta's algorithm to optimize efficiently. Starting at ${storeData.store.currency_symbol || ""}${tierLocal.toLocaleString()} is possible but expect a longer learning phase. Consider starting with Add to Cart optimization instead of Purchase.`;
  } else if (aovGuardrailUSD > totalDailySpendUSD) {
    finalDailyUSD = aovGuardrailUSD;
  } else {
    finalDailyUSD = totalDailySpendUSD;
  }

  const recommendedDailyLocal = finalDailyUSD * exchangeRate;
  const recommendedDaily = Math.round(recommendedDailyLocal);

  // Multi-market allocation decision
  const intlFloorStrategies = getInternationalStrategies(storeCurrency, exchangeRate);
  const MIN_INTL_DAILY_LOCAL = intlFloorStrategies[0]?.daily || Math.round(18 * exchangeRate);
  const intlFloorFormatted = getInternationalBudgetFloor(storeCurrency, exchangeRate);

  let adSets: number;
  let adSetReasoning: string;

  if (hasInternationalDemand) {
    const intlCityNames = internationalLocations.map((l) => l.city).join(" · ");
    adSets = 1;
    adSetReasoning =
      `Recommended Plan: 1 consolidated ad set at ${formatCurrency(recommendedDaily, storeCurrency, storeData.store.currency_symbol)}/day focused on your primary domestic market.\n\n` +
      `💡 Optional Overseas Expansion: Should you ever wish to explore international demand in ${intlCityNames}, launch a separate overseas ad set at ${intlFloorFormatted}. You do not need to run both at once — master your local market first to protect your cash flow.`;
  } else {
    // Pure domestic store
    adSets = 1;
    adSetReasoning = `Recommended Plan: 1 consolidated ad set at ${formatCurrency(recommendedDaily, storeCurrency, storeData.store.currency_symbol)}/day to focus your entire budget into Meta's Advantage+ algorithm without splitting your spend.`;
  }

  // Run unified AI single-pass call
  const profile = await generateTargetingProfile(
    storeData,
    adSets,
    recommendedDaily,
    userId,
    targetProductOverride
  );

  // --- Advantage+ Guidance & Creative Hooks ---
  const advantage_plus_guidance: AdvantagePlusGuidance = {
    campaign_type: guidance.campaign_type,
    optimization_event: guidance.optimization_event,
    optimization_reasoning:
      profile.optimization_reasoning || guidance.default_reasoning,
    seed_audience_suggestions: {
      age_min: profile.demographics.age_min,
      age_max: profile.demographics.age_max,
      gender: profile.demographics.gender,
      demographic_justification: profile.demographics.demographic_justification,
      seed_interests: profile.seed_interests,
    },
  };

  const creative_hooks = profile.creative_hooks;

  // --- TARGETING (Backward compatibility) ---
  const gender = profile.demographics.gender;
  const finalAgeMin = profile.demographics.age_min || 25;
  const finalAgeMax = profile.demographics.age_max || 44;
  const finalAgeReasoning =
    profile.demographics.age_reasoning ||
    "Standard e-commerce age targeting (25-44) is highly recommended for early validation campaigns.";
  const locations = profile.locations;
  const interests = profile.seed_interests;

  // Goal multipliers
  const goalMultipliers: Record<string, number> = {
    "Drive Website Sales": 1.0,
    "Grow Brand Awareness": 0.6,
    "Promote a New Collection": 1.2,
    "Retarget Past Visitors": 0.4,
  };

  // ── Strategies ──
  const strategies = [
    {
      label: "Dip Your Toe",
      daily: Math.round(finalDailyUSD * 0.7 * exchangeRate),
      total_daily:
        Math.round(finalDailyUSD * 0.7 * exchangeRate) * adSets,
      description:
        "Low risk, slow learning. Good if you're testing for the first time.",
    },
    {
      label: "Sweet Spot",
      daily: recommendedDaily,
      total_daily: recommendedDaily * adSets,
      description:
        "Our recommendation. Enough budget for Meta to learn without burning cash.",
    },
    {
      label: "Full Send",
      daily: Math.round(finalDailyUSD * 1.4 * exchangeRate),
      total_daily:
        Math.round(finalDailyUSD * 1.4 * exchangeRate) * adSets,
      description:
        "Faster results but higher daily spend. Best when you already know your creative works.",
    },
  ];

  const internationalStrategies = getInternationalStrategies(storeCurrency, exchangeRate);

  const budgetReasoning =
    avgMonthlyRevenue > 0
      ? `Based on your monthly store revenue of ${formatCurrency(Math.round(avgMonthlyRevenue), storeCurrency, storeData.store.currency_symbol)}, ` +
        adSetReasoning
      : `Based on your product price point of ${formatCurrency(Math.round(effectiveAOV), storeCurrency, storeData.store.currency_symbol)} and our Starter Testing model, ` +
        adSetReasoning;

  // Check high budget warning
  let highBudgetWarning = false;
  let highBudgetWarningMessage: string | undefined;

  if (!budgetWarning && finalDailyUSD > 50) {
    highBudgetWarning = true;
    const formattedAmount = formatCurrency(
      recommendedDaily,
      storeCurrency,
      storeData.store.currency_symbol
    );
    highBudgetWarningMessage = `Your product price point requires a minimum daily budget of ${formattedAmount} for Meta's algorithm to optimize. Ensure this budget is available before launching.`;
  }

  // --- TIMING ---
  const timing = profile.timing;

  // --- PLACEMENTS ---
  const placements = [
    "Facebook Feed",
    "Instagram Feed",
    "Instagram Stories",
    "Instagram Reels",
  ];

  // --- PRODUCTS ---
  const sortedProducts = [...storeData.products].sort(
    (a, b) => b.revenue - a.revenue
  );
  const topProducts = sortedProducts
    .filter((p) => p.should_advertise)
    .slice(0, 5)
    .map((p) => p.name);
  const productsToAvoid = storeData.products
    .filter((p) => !p.should_advertise)
    .map((p) => `${p.name}${p.reason ? ` (${p.reason})` : ""}`);

  // --- STORE HEALTH ---
  const productScore = scoreProducts(storeData.products);
  const orderScore = scoreOrders(storeData.orders.orders_last_30_days);
  const retentionScore = scoreRetention(storeData.orders.repeat_customer_rate);
  const availabilityScore = scoreAvailability(storeData.products);

  const healthBreakdown = [
    {
      label: "Active Products",
      score: productScore.score,
      max: productScore.max,
      status: productScore.status,
      percentage: Math.round((productScore.score / productScore.max) * 100),
    },
    {
      label: "Recent Orders",
      score: orderScore.score,
      max: orderScore.max,
      status: orderScore.status,
      percentage: Math.round((orderScore.score / orderScore.max) * 100),
    },
    {
      label: "Customer Retention",
      score: retentionScore.score,
      max: retentionScore.max,
      status: retentionScore.status,
      percentage: Math.round((retentionScore.score / retentionScore.max) * 100),
    },
    {
      label: "Product Availability",
      score: availabilityScore.score,
      max: availabilityScore.max,
      status: availabilityScore.status,
      percentage: Math.round(
        (availabilityScore.score / availabilityScore.max) * 100
      ),
    },
  ] as MetaRecommendations["health_breakdown"];

  const storeHealthScore =
    productScore.score +
    orderScore.score +
    retentionScore.score +
    availabilityScore.score;

  // --- WARNINGS ---
  const warnings: string[] = [];
  const outOfStockCount = storeData.products.filter((p) => !p.in_stock).length;
  if (outOfStockCount > 0) {
    warnings.push(
      `${outOfStockCount} product${outOfStockCount > 1 ? "s" : ""} out of stock — these won't be recommended for ads`
    );
  }
  if (storeData.orders.orders_last_30_days === 0) {
    warnings.push(
      "No orders in last 30 days — targeting recommendations are limited without purchase data"
    );
  }

  const currencyAovUSD = storeData.orders.average_order_value / exchangeRate;
  if (currencyAovUSD > 0 && currencyAovUSD < 15) {
    warnings.push(
      `Low average order value (${Math.round(storeData.orders.average_order_value).toLocaleString()} ${storeCurrency}) — ad costs may exceed profit per sale`
    );
  }

  if (newStoreCautionMessage) {
    warnings.push(newStoreCautionMessage);
  }
  if (highBudgetWarningMessage) {
    warnings.push(highBudgetWarningMessage);
  }

  // --- OPPORTUNITIES ---
  const opportunities: string[] = [];
  if (storeData.orders.repeat_customer_rate > 0.2) {
    opportunities.push(
      "Your repeat customer rate is strong — create a lookalike audience from your top buyers for lower acquisition costs"
    );
  }
  if (storeData.orders.peak_days.length > 0) {
    opportunities.push(
      `Peak buying detected on ${storeData.orders.peak_days.slice(0, 2).join(" and ")} — consider launching campaigns 1-2 days earlier to build momentum`
    );
  }
  if (currencyAovUSD > 150) {
    opportunities.push(
      "High average order value — consider premium interest targeting for higher-intent audiences"
    );
  }

  const effectiveCountry = getEffectiveStoreCountry(
    storeData.store.country,
    storeCurrency,
    storeData.orders.top_locations
  );
  const isTier1 = isTier1Market(effectiveCountry, storeCurrency);

    // Always include ALL domestic cities from store order data first, then supplement with AI-suggested ones
    const storeDataDomesticLocs: LocationResult[] = domesticLocations.map((l) => ({
      name: l.city,
      country: l.country,
      market_type: "domestic" as const,
      source: "from_data" as const,
      percentage: l.percentage,
      note: "Domestic location signal from store data",
    }));
    const storeDataDomesticNames = new Set(storeDataDomesticLocs.map((l) => l.name.toLowerCase()));
    const aiDomesticExtra = locations
      .filter((l) => {
        const isDom = l.market_type === "domestic" || isDomestic(l.name || "", (l as { country?: string }).country);
        return isDom && !storeDataDomesticNames.has((l.name || "").toLowerCase());
      })
      .map((l) => ({ ...l, source: "recommended" as const, market_type: "domestic" as const }));

    const finalDomesticLocations: LocationResult[] =
      storeDataDomesticLocs.length > 0
        ? [...storeDataDomesticLocs, ...aiDomesticExtra]
        : locations
            .filter((l) => l.market_type === "domestic" || isDomestic(l.name || "", (l as { country?: string }).country))
            .map((l) => ({ ...l, source: "recommended" as const, market_type: "domestic" as const }));

    // International locations: combine real store order data with AI-inferred strategic international hubs
    const storeDataIntlLocs: LocationResult[] = internationalLocations.map((l) => ({
      name: l.city,
      country: l.country,
      market_type: "international" as const,
      source: "from_data" as const,
      percentage: l.percentage,
      note: "Overseas location signal from store data",
    }));
    const storeDataIntlNames = new Set(storeDataIntlLocs.map((l) => l.name.toLowerCase()));
    const aiIntlExtra = locations
      .filter((l) => {
        const isIntl = l.market_type === "international" || (!isDomestic(l.name || "", (l as { country?: string }).country));
        return isIntl && !storeDataIntlNames.has((l.name || "").toLowerCase());
      })
      .map((l) => ({ ...l, source: "recommended" as const, market_type: "international" as const }));

    const finalInternationalLocations: LocationResult[] =
      storeDataIntlLocs.length > 0
        ? [...storeDataIntlLocs, ...aiIntlExtra]
        : isTier1
        ? []
        : locations
            .filter((l) => l.market_type === "international" || (!isDomestic(l.name || "", (l as { country?: string }).country)))
            .map((l) => ({ ...l, source: "recommended" as const, market_type: "international" as const }));

    const domesticBudgetFormatted =
      formatCurrency(
        adSets === 2 ? Math.round(recommendedDaily * 0.65) : recommendedDaily,
        storeCurrency,
        storeData.store.currency_symbol
      ) + "/day";

    const intlBudgetFormatted =
      formatCurrency(
        adSets === 2
          ? Math.max(Math.round(recommendedDaily * 0.35), MIN_INTL_DAILY_LOCAL)
          : MIN_INTL_DAILY_LOCAL,
        storeCurrency,
        storeData.store.currency_symbol
      ) +
      "/day" +
      (adSets === 1 ? " ($18/day min)" : "");

    return {
    ...(lowDataWarningCheck(storeData)
      ? {}
      : {
          newStoreCaution,
          newStoreCautionMessage,
          highBudgetWarning,
          highBudgetWarningMessage,
          budgetWarning,
          budgetWarningMessage,
        }),
    creative_hooks,
    advantage_plus_guidance,
    targeting: {
      locations: finalDomesticLocations,
      domestic_locations: finalDomesticLocations,
      international_locations:
        finalInternationalLocations.length > 0
          ? finalInternationalLocations
          : undefined,
      domestic_budget_formatted: domesticBudgetFormatted,
      international_budget_formatted:
        finalInternationalLocations.length > 0
          ? intlBudgetFormatted
          : undefined,
      overseas_demand:
        finalInternationalLocations.length > 0
          ? finalInternationalLocations.map((l) => l.name)
          : undefined,
      age_min: finalAgeMin,
      age_max: finalAgeMax,
      age_reasoning: finalAgeReasoning,
      gender,
      gender_reasoning: profile.demographics.demographic_justification,
      interests,
      interest_reasoning:
        "Advantage+ seed interests to kickstart algorithmic exploration.",
    },
    budget: {
      recommended_daily: recommendedDaily,
      recommended_duration_days: TEST_DURATION_DAYS,
      reasoning: budgetReasoning,
      currency: storeCurrency,
      currency_symbol: storeData.store.currency_symbol,
      tier: budgetTier,
      ad_sets: adSets,
      optimization_event: {
        event: guidance.optimization_event,
        reasoning:
          profile.optimization_reasoning || guidance.default_reasoning,
        target_weekly: guidance.optimization_event === "Purchase" ? 20 : 10,
        upgrade_milestone:
          guidance.optimization_event === "AddToCart"
            ? "Switch to InitiateCheckout or Purchase once you see consistent weekly checkout events."
            : guidance.optimization_event === "InitiateCheckout"
            ? "Switch to Purchase optimization once you get 15+ weekly purchases."
            : "Optimize directly for Purchase.",
      },
      ad_set_reasoning: adSetReasoning,
      breakdown: {
        revenue_based: avgMonthlyRevenue,
        aov_based: Math.round(effectiveAOV),
        goal_multipliers: goalMultipliers,
        meta_optimal_daily: strategies[0].daily,
      },
      strategies,
      international_strategies: internationalStrategies,
      international_recommended_daily: internationalStrategies[1]?.daily,
    },
    timing,
    placements: {
      recommended: placements,
    },
    top_products_to_advertise: topProducts,
    products_to_avoid: productsToAvoid,
    store_health_score: storeHealthScore,
    health_breakdown: healthBreakdown,
    warnings,
    opportunities,
  };
}

function lowDataWarningCheck(storeData: StoreData): boolean {
  return storeData.orders.order_count < 20;
}
