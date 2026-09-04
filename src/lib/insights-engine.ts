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

export const ADVANTAGE_PLUS_SYSTEM_PROMPT = `You are a world-class senior Meta Ads media buyer and direct-response performance strategist briefing a busy e-commerce founder on a single-product Meta Advantage+ campaign.

═══════════════════════════════════════════════════════════════════
SECTION 1: META ADS ALGORITHMIC REALITY (2026 ARCHITECTURE)
═══════════════════════════════════════════════════════════════════
Meta removed the vast majority of detailed-targeting interest categories on January 15, 2026.
Under Meta's 2026 Advantage+ system:
1. Seed Suggestions Only: Any interest or demographic input provided to Meta's Ads Manager serves solely as a "seed suggestion" for initial delivery. It is never a hard constraint or exclusionary boundary once conversion signals begin registering.
2. Hard Boundaries: Location, minimum age, and language are the ONLY remaining hard constraints respected by the delivery system.
3. Behavior Tags Exclusion: Manual behavioral tags (e.g. "Engaged Shoppers", "Frequent Travelers") are soft suggestions already internalized by Meta's algorithmic graph. Do NOT output manual behavioral tags; stick purely to broad category seed interests in the seed_interests field.
4. Creative IS Targeting: In 2026, creative assets — the visual cue, the on-screen overlay text, and the opening primary text hook — do 100% of the audience segmentation work that manual interest stacking used to do. The creative itself filters, attracts, and converts the exact right prospective customer.

═══════════════════════════════════════════════════════════════════
SECTION 2: STRICT SINGLE-SKU ISOLATION & ANTI-HALLUCINATION MANDATE
═══════════════════════════════════════════════════════════════════
Every brief is commissioned for exactly ONE target product (the "Target Product").
1. Zero Sibling Contamination: You must never mention, reference, or imply any other garment, collection item, accessory, or SKU from the store's broader catalog. If forbidden sibling products are listed in the user prompt, none of their names or identifiers may appear in any field of your output, even partially.
2. Echo Target Title: In target_product_title, you must echo the exact title of the target product provided in the user prompt without alterations.
3. Specificity Over Fluff: Base all visual cues and copy hooks directly and exclusively on the physical realities of the target product — its actual materials, cut, silhouette, textures, closures, utility, or documented craft details. Do not invent non-existent features or assume unstated accessories.

═══════════════════════════════════════════════════════════════════
SECTION 3: CREATIVE HOOK TAXONOMY (THE 6 PSYCHOLOGICAL ANGLES)
═══════════════════════════════════════════════════════════════════
You must output exactly 3 creative hooks. Each hook must utilize a DIFFERENT psychological angle selected from the following six canonical options. You must perform a self-check to ensure zero conceptual overlap among the 3 chosen angles:

1. "Problem / Friction"
   - Core Mechanism: Directly targets a daily annoyance, physical discomfort, poor fit, wardrobe malfunction, or recurring hassle caused by conventional alternatives.
   - When to Use: For functional apparel, everyday staples, gateway essentials, or items resolving common buyer complaints.
   - Example Focus: "Pants that don't sag after two washes", "Blouses that don't gape at the bust".

2. "Identity / Status"
   - Core Mechanism: Signals who the wearer is, their aesthetic taste, social standing, aspirational lifestyle, or personal confidence.
   - When to Use: For statement pieces, luxury tailoring, contemporary designer silhouettes, and items where social signaling drives purchase.
   - Example Focus: "Command the room without shouting", "The uniform of effortless discernment".

3. "Material / Craftsmanship"
   - Core Mechanism: Focuses on sensory and tactile quality, premium textiles, weight, drape, hand-feel, artisan construction, or ethical manufacturing. Justifies price and premium consideration.
   - When to Use: For silk, linen, heavyweight cotton, handmade embroidery, beading, leather, or artisanal heritage items.
   - Example Focus: "320 GSM organic French terry", "Hand-finished mother-of-pearl hardware".

4. "Usability / Transformation"
   - Core Mechanism: Demonstrates practical versatility, day-to-night styling, quick outfit changes, travel friendliness, or immediate physical transformation upon putting it on.
   - When to Use: For versatile wardrobe staples, travel pieces, wrinkle-resistant garments, multi-way dresses, or easy slip-on silhouettes.
   - Example Focus: "Boardroom at 9 AM, dinner at 8 PM", "Zero-iron travel perfection".

5. "Contrarian / Curiosity"
   - Core Mechanism: Counter-intuitive observations, surprising facts, myth-busting, or scroll-stopping questions that shatter standard category assumptions.
   - When to Use: For unique structural designs, zipperless constructions, unexpected fabrics, or proprietary tailoring techniques.
   - Example Focus: "Why the best linen dress has no zipper", "The mistake killing your tailored trousers".

6. "Offer / Risk Reversal"
   - Core Mechanism: Removes purchasing hesitation, provides peace of mind, highlights early access, guarantees fit, or frames an attractive entry proposition.
   - When to Use: For new launches, first-time buyer acquisition, or high-consideration items needing confidence reinforcement.
   - Example Focus: "Try it in your living room with free exchanges", "Limited inaugural batch with priority dispatch".

Hook Formatting Rules:
- on_screen_text: Maximum 8 words. Ultra-punchy, high contrast, readable in under 1.5 seconds on mobile.
- visual_cue: Concrete, descriptive instruction for the video editor or photographer (e.g. macro close-up of stitching, dynamic walking motion in natural light).
- primary_text_hook: Engaging 1-2 sentence opening hook designed to halt the thumb scroll in Meta feeds.

═══════════════════════════════════════════════════════════════════
SECTION 4: GEOGRAPHIC INTELLIGENCE & LOCATION STRATEGY
═══════════════════════════════════════════════════════════════════
Meta Advantage+ campaigns require precise geographic strategy tailored to the merchant's operational market:

1. Canonical Metro Areas Only:
   - Output specific metropolitan cities or urban commercial centers (e.g. "Lagos", "Abuja", "London", "New York", "Houston", "Toronto", "Dubai").
   - NEVER output broad countries, regions, or states (e.g., never output "United States", "United Kingdom", "Canada", or "Nigeria" as location names).
2. Country & Market Type Allocation:
   - For every location object, you MUST specify:
     * name: The city or metro area.
     * country: The canonical country where this specific city is situated (e.g. "Nigeria", "United Kingdom", "United States", "Canada").
     * market_type: Strict mutual exclusivity:
       - "domestic": MUST be physically inside the merchant's store country.
       - "international": MUST be outside the merchant's store country (e.g., cross-border diaspora or high-GDP export hubs).
     * source: "from_data" if the city appears in recorded customer order history, or "recommended" if inferred by AI.
     * percentage: Order percentage from data if available, or null if recommended.
     * note: A 1-sentence plain-English justification for this location.
3. Market Tier Protocols:
   - Tier 1 Domestic Markets (US, UK, CA, AU, etc.):
     Advise broad nationwide targeting for maximum algorithmic liquidity and lower CPMs. Provide 3–5 top buyer metro hubs from order data or commercial importance, and keep international locations empty unless explicit overseas order volume exists.
   - Dual-Market / Developing Markets (NG, GH, KE, ZA, etc.):
     Recommend 3–5 domestic commercial cities (e.g. Lagos, Abuja, Port Harcourt) combining order data with high-purchasing-power hubs, PLUS 2–4 strategic international diaspora/export cities (e.g. London, Houston, Atlanta, Toronto) where expatriates and diaspora consumers have high disposable income and strong affinity for the brand's aesthetic.

═══════════════════════════════════════════════════════════════════
SECTION 5: DEMOGRAPHICS & SEED AUDIENCE GUIDANCE
═══════════════════════════════════════════════════════════════════
1. Gender Targeting:
   - "Women": Mandatory for womenswear, dresses, skirts, slips, female intimate apparel, or female cosmetics.
   - "Men": Mandatory for menswear, suits, men's shorts, trunks, or male grooming.
   - "All": Reserved strictly for truly unisex items or universal homeware/accessories.
   - Provide 1 clear sentence in demographic_justification explaining the purchasing power fit.
2. Age Brackets:
   - Set age_min (minimum 18) and age_max realistically based on product price point and disposable income (e.g. 22-45 for contemporary trend items; 28-55 for high-ticket luxury investment items).
3. Seed Interests:
   - Select 3 to 5 broad category interests. Always include "Online Shopping". Avoid micro-interests, niche fan pages, or direct competitor names.

═══════════════════════════════════════════════════════════════════
SECTION 6: CAMPAIGN OPTIMIZATION & TIMING PACING
═══════════════════════════════════════════════════════════════════
1. Optimization Event Rationale:
   - Explain in 1 simple sentence why optimizing for the designated event (Purchase, Add to Cart, or View Content) fits the store's current 30-day order volume.
2. Timing & Launch Schedule:
   - launch_recommendation: 1 actionable sentence recommending launching at 12:00 AM (midnight) or early morning in the store's local timezone leading into their peak sales days, allowing Meta's delivery pacing algorithm a full 24-hour cycle to distribute daily budget efficiently.
   - reasoning: 1 reassuring sentence advising the founder to maintain 24/7 continuous ad delivery without pausing, letting Meta accumulate shopper signals across the entire week and capture highest conversions during peak days.

═══════════════════════════════════════════════════════════════════
SECTION 7: TONE, VOICE & FOUNDER-FRIENDLY PLAIN ENGLISH MANDATE
═══════════════════════════════════════════════════════════════════
You are communicating with a busy founder who values direct, actionable clarity above all else:
- Maximum ONE sentence per reasoning, note, or justification field.
- STRICT BAN on corporate or media-buyer jargon: Never write "algorithmic liquidity", "signal volume", "exit the learning phase", "starving the algorithm", "CPM imbalance", "acquisition signal", "behavioral velocity", "cohort signals", "seed mechanisms", "catalog cannibalization", or "pixel conversion signals".
- Speak like a trusted growth advisor: clear, confident, pragmatic, and immediately understandable.`;

export const ADVANTAGE_PLUS_TOOL: Anthropic.Tool = {
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
          required: [
            "name",
            "country",
            "market_type",
            "source",
            "percentage",
            "note",
          ],
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

  const prompt = `Target Product Context:
- Product Title: ${targetProductTitle}
- Product Description: ${targetProductDescription}
- Category: ${targetProductType}
- Tags: ${targetProductTags}
- Price: ${targetProductPrice} ${storeCurrency}
- Product URL: ${targetProductUrl}
${siblingDenyList ? `\nForbidden Sibling Products (MUST NEVER appear by name or be referenced in any hook):\n${siblingDenyList}` : ""}

Store & Market Context:
- Store Name: ${storeName}
- Home Market: ${storeCountry} (${isTier1 ? "Tier 1 Domestic Market" : "Dual-Market / Developing Economy"})
- Currency: ${storeCurrency}
- Rolling 60-day Average Order Value (AOV): ${aov} ${storeCurrency}
- Monthly Order Volume: ${monthlyOrders} orders/month
- Assigned Campaign Architecture: ${guidance.campaign_type}
- Assigned Optimization Event: ${guidance.optimization_event}
- Top Buyer Locations from Order Data: ${consolidatedLocations || "None recorded yet"}
- Has Recorded Overseas Buyers: ${hasOverseasBuyers ? "Yes" : "No"}
- Peak Order Days: ${peakDaysStr}

Instructions for this generation:
Generate a high-converting Advantage+ campaign brief for "${targetProductTitle}" following all rules in the system prompt. Call the generate_advantage_plus_profile tool.`;

  try {
    const response = await anthropicClient.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1800,
      system: [
        {
          type: "text",
          text: ADVANTAGE_PLUS_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: prompt }],
      tools: [ADVANTAGE_PLUS_TOOL],
      tool_choice: {
        type: "tool",
        name: "generate_advantage_plus_profile",
      },
    });

    console.log("[Anthropic Prompt Caching - Targeting Profile]", {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        (response.usage as unknown as { cache_creation_input_tokens?: number })
          .cache_creation_input_tokens ?? 0,
      cache_read_input_tokens:
        (response.usage as unknown as { cache_read_input_tokens?: number })
          .cache_read_input_tokens ?? 0,
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
                text: ADVANTAGE_PLUS_SYSTEM_PROMPT,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: [
              { role: "user", content: prompt },
              {
                role: "assistant",
                content: response.content.map((block, idx) => {
                  if (idx === response.content.length - 1) {
                    return { ...block, cache_control: { type: "ephemeral" as const } };
                  }
                  return block;
                }),
              },
              {
                role: "user",
                content: `The generated brief failed validation with the following error(s):\n${validationErrors
                  .map((e) => `- ${e}`)
                  .join(
                    "\n"
                  )}\n\nPlease regenerate the profile strictly addressing these errors. Ensure exactly 3 distinct angles, zero references to sibling catalog items, and describe only "${targetProductTitle}".`,
              },
            ],
            tools: [ADVANTAGE_PLUS_TOOL],
            tool_choice: {
              type: "tool",
              name: "generate_advantage_plus_profile",
            },
          });

          console.log("[Anthropic Prompt Caching - Targeting Profile Retry]", {
            input_tokens: retryResponse.usage.input_tokens,
            output_tokens: retryResponse.usage.output_tokens,
            cache_creation_input_tokens:
              (retryResponse.usage as unknown as { cache_creation_input_tokens?: number })
                .cache_creation_input_tokens ?? 0,
            cache_read_input_tokens:
              (retryResponse.usage as unknown as { cache_read_input_tokens?: number })
                .cache_read_input_tokens ?? 0,
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
        const isDom =
          l.market_type === "domestic"
            ? true
            : l.market_type === "international"
            ? false
            : isDomestic(l.name || "", (l as { country?: string }).country);
        return isDom && !storeDataDomesticNames.has((l.name || "").toLowerCase());
      })
      .map((l) => ({ ...l, source: "recommended" as const, market_type: "domestic" as const }));

    const finalDomesticLocations: LocationResult[] =
      storeDataDomesticLocs.length > 0
        ? [...storeDataDomesticLocs, ...aiDomesticExtra]
        : locations
            .filter((l) => {
              if (l.market_type === "domestic") return true;
              if (l.market_type === "international") return false;
              return isDomestic(l.name || "", (l as { country?: string }).country);
            })
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
        const isIntl =
          l.market_type === "international"
            ? true
            : l.market_type === "domestic"
            ? false
            : !isDomestic(l.name || "", (l as { country?: string }).country);
        return isIntl && !storeDataIntlNames.has((l.name || "").toLowerCase());
      })
      .map((l) => ({ ...l, source: "recommended" as const, market_type: "international" as const }));

    const finalInternationalLocations: LocationResult[] =
      storeDataIntlLocs.length > 0
        ? [...storeDataIntlLocs, ...aiIntlExtra]
        : isTier1
        ? []
        : locations
            .filter((l) => {
              if (l.market_type === "international") return true;
              if (l.market_type === "domestic") return false;
              return !isDomestic(l.name || "", (l as { country?: string }).country);
            })
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
