import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { getUserIntegration, logApiUsage } from "@/lib/db";
import { getAdvantagePlusGuidance } from "@/lib/advantage-plus";
import { isTier1Market, isDomesticCity } from "@/lib/market-geography";
import {
  validateBrief,
  sanitizeLeakedTokens,
  type TargetProductContext,
  type CatalogItem,
  type GeneratedBriefResponse,
} from "@/lib/validate-brief";
import type { StoreData } from "@/lib/store-data";

export const runtime = "nodejs";
export const maxDuration = 60;

const anthropicClient = new Anthropic();

interface GenerateBriefRequestBody {
  targetProduct?: {
    id?: string;
    title: string;
    tags?: string[];
    product_type?: string;
    price?: number | string;
    url?: string;
  };
  catalog?: CatalogItem[];
  storeData?: StoreData;
}

export async function POST(request: Request) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  const limited = await enforceRateLimit({
    action: "brief:generate",
    identifier: userId,
    limit: 25,
    windowSeconds: 3600,
  });
  if (!limited.ok) return limited.response;

  try {
    let body: GenerateBriefRequestBody = {};
    try {
      body = await request.json();
    } catch {
      // Body may be empty if relying completely on integration snapshot
    }

    const integration = await getUserIntegration(userId);
    const storeSnapshot = (body.storeData ||
      integration?.store_snapshot) as StoreData | undefined;

    if (!storeSnapshot) {
      return NextResponse.json(
        { error: "No store data available. Sync your store first." },
        { status: 400 }
      );
    }

    const monthlyOrders =
      storeSnapshot.orders?.orders_last_30_days ||
      storeSnapshot.orders?.order_count ||
      0;
    const storeCurrency = storeSnapshot.store?.currency || "USD";
    const guidance = getAdvantagePlusGuidance(monthlyOrders);

    // Consolidated Buyer Locations
    const consolidatedLocations = (storeSnapshot.orders?.top_locations || [])
      .map((l) => `${l.city} (${l.percentage}%)`)
      .join(", ");

    // Target Product Resolution
    const rawTarget =
      body.targetProduct ||
      (storeSnapshot.products && storeSnapshot.products.length > 0
        ? [...storeSnapshot.products].sort(
            (a, b) => (b.revenue || 0) - (a.revenue || 0)
          )[0]
        : {
            id: "target-1",
            title: storeSnapshot.store?.name || "Main Collection Item",
            price: Math.round(storeSnapshot.orders?.average_order_value || 50),
            tags: ["bestseller"],
            product_type: "General",
          });

    const targetTitle =
      (rawTarget as { title?: string; name?: string }).title ||
      (rawTarget as { name?: string }).name ||
      "Target Product";

    const targetProductCtx: TargetProductContext = {
      id: rawTarget.id || targetTitle,
      title: targetTitle,
      tags: rawTarget.tags || [],
      product_type:
        rawTarget.product_type ||
        (rawTarget as { collection?: string }).collection ||
        "General",
      price: rawTarget.price,
      url: (rawTarget as { url?: string }).url,
    };

    const catalog: CatalogItem[] =
      body.catalog ||
      (storeSnapshot.products || []).map((p) => ({
        id: (p as { id?: string }).id || p.name,
        title: p.name,
      }));

    const targetProductDescription =
      (rawTarget as { description?: string }).description || "None provided";
    const targetProductType = targetProductCtx.product_type || "General";
    const targetProductTags = (targetProductCtx.tags || []).join(", ") || "None";
    const targetProductPrice =
      targetProductCtx.price ||
      Math.round(storeSnapshot.orders?.average_order_value || 0);
    const targetProductUrl =
      targetProductCtx.url ||
      `https://${storeSnapshot.store?.domain || "store.com"}`;
    const storeName = storeSnapshot.store?.name || "Our Store";
    const storeCountry = storeSnapshot.store?.country || "US";
    const isTier1 = isTier1Market(storeCountry, storeCurrency);
    const hasOverseasBuyers = (storeSnapshot.orders?.top_locations || []).some(
      (l) => !isDomesticCity(l.city || "", l.country, storeCountry, storeCurrency, storeSnapshot.orders?.top_locations)
    );
    const aov = Math.round(storeSnapshot.orders?.average_order_value || 0);
    const peakDaysStr =
      storeSnapshot.orders?.peak_days &&
      storeSnapshot.orders.peak_days.length > 0
        ? storeSnapshot.orders.peak_days.join(", ")
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

    // System Prompt v4
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
You are writing a brief for exactly one product: ${targetTitle}.
Product Description: ${targetProductDescription}
You have NOT been given the rest of the store's catalog, on purpose. Every visual cue, on-screen text, and primary text hook must describe ${targetTitle} and its specific details (${targetProductDescription}) and nothing else — no other garment, set, or SKU, named or implied. If you describe "the drape of X" or "styled in Y" where X or Y is not ${targetTitle}, you are hallucinating sibling catalog items. Describe ONLY the target product's specific materials, cut, texture, fit, or utility as described in its product details.
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
    * Include top-converting economic cities within the store's home country (${storeCountry}) from actual order data (source: "from_data").
    * In addition, dynamically infer complementary high-converting commercial hubs or state capitals with strong purchasing power for ${targetProductPrice} ${storeCurrency} products (source: "recommended"). For example, for Nigeria: Lagos, Abuja, Port Harcourt, Ibadan, Asaba, Benin City.
  - International Export & Diaspora Market (2–4 international cities):
    * If the store has recorded overseas buyers, include them (source: "from_data").
    * In addition, dynamically infer 2–3 high-purchasing-power international cities with proven diaspora demand or export purchasing power for this type of product (source: "recommended"), such as Greater London, New York, Toronto, Houston, Atlanta.`
}
  - Each location item must include a concise, plain-English note explaining why it's a top buying hub for this store/product.
- Gender Selection:
  - If the product is specifically for women (e.g. dresses, skirts, mini slips, robes, bras, heels, women's co-ords, women's lingerie/fashion), you MUST select gender: "Women".
  - If the product is specifically for men (e.g. men's suits, boxer briefs, men's shorts, trunks), you MUST select gender: "Men".
  - Only select gender: "All" if the product is genuinely unisex or universal.
- In demographic_justification, write 1 simple sentence explaining the gender selection and purchasing power fit.
- Select 3–5 broad category interests (always include "Online Shopping"). Avoid competitor names or niche interest stacking.

Store & Product Context
Target Product: ${targetTitle}
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

Creative hooks: exactly 3 distinct angles dynamically inferred from ${targetTitle}'s attributes, price point (${aov} ${storeCurrency}), and buyer mindset:
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
    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      throw new Error("No structured brief profile returned from LLM");
    }

    let profile = toolUseBlock.input as GeneratedBriefResponse;

    logApiUsage(
      userId,
      "brief_generation_v4",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    // ─── Code-Side Deterministic Validator ───
    let validationErrors = validateBrief(profile, targetProductCtx, catalog);

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
                )}\n\nPlease regenerate the profile strictly addressing these errors. Ensure exactly 3 distinct angles, zero references to sibling catalog items, and describe only "${targetTitle}".`,
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
          validationErrors = validateBrief(profile, targetProductCtx, catalog);
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
        profile = sanitizeLeakedTokens(profile, targetProductCtx, catalog);
      }
    }

    return NextResponse.json({
      success: true,
      target_product: targetProductCtx,
      profile,
      advantage_plus_guidance: {
        campaign_type: guidance.campaign_type,
        optimization_event: guidance.optimization_event,
        optimization_reasoning:
          profile.optimization_reasoning || guidance.default_reasoning,
        seed_audience_suggestions: {
          age_min: profile.demographics?.age_min || 25,
          age_max: profile.demographics?.age_max || 44,
          gender: profile.demographics?.gender || "All",
          demographic_justification:
            profile.demographics?.demographic_justification ||
            "Demographic profile aligned with product price point and buyer history.",
          seed_interests: profile.seed_interests || ["Online Shopping"],
        },
      },
    });
  } catch (error) {
    console.error("[/api/generate-brief] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to generate Advantage+ brief",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
