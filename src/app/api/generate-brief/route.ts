import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/api/require-user";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { getUserIntegration, logApiUsage } from "@/lib/db";
import { getAdvantagePlusGuidance } from "@/lib/advantage-plus";
import {
  isTier1Market,
  isDomesticCity,
  getEffectiveStoreCountry,
} from "@/lib/market-geography";
import {
  validateBrief,
  sanitizeLeakedTokens,
  type TargetProductContext,
  type CatalogItem,
  type GeneratedBriefResponse,
} from "@/lib/validate-brief";
import type { StoreData } from "@/lib/store-data";
import {
  ADVANTAGE_PLUS_SYSTEM_PROMPT,
  ADVANTAGE_PLUS_TOOL,
} from "@/lib/insights-engine";

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
    const storeCountry = getEffectiveStoreCountry(
      storeSnapshot.store?.country,
      storeCurrency,
      storeSnapshot.orders?.top_locations
    );
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

    // Matched product & attribution signals
    const matchedProduct = storeSnapshot.products?.find(
      (p) =>
        (p.id && targetProductCtx.id && p.id.toString() === targetProductCtx.id.toString()) ||
        p.name.trim().toLowerCase() === targetTitle.trim().toLowerCase()
    );

    let productRole = "Catalog Bestseller";
    if (
      matchedProduct?.gateway_classification === "Gateway" ||
      (matchedProduct?.first_time_buyer_ratio || 0) >= 0.5
    ) {
      const ftbPct = Math.round((matchedProduct?.first_time_buyer_ratio || 0.6) * 100);
      productRole = `Gateway Product (the front door bringing in ${ftbPct}% new first-time customers)`;
    } else if (
      matchedProduct?.gateway_classification === "Consideration" ||
      (matchedProduct?.repeat_purchase_rate || 0) > 0.15
    ) {
      productRole = "High-Consideration Product (frequently purchased by customers returning to the brand)";
    }

    const primaryTrafficSource =
      matchedProduct?.top_acquisition_channel ||
      storeSnapshot.orders?.acquisition_channels?.[0]?.channel ||
      "Direct / Social Discovery";

    let reorderHabit = "Early Growth (Focus on driving profitable first-time discovery)";
    if ((matchedProduct?.repeat_purchase_rate || 0) > 0.15) {
      const repPct = Math.round((matchedProduct?.repeat_purchase_rate || 0) * 100);
      reorderHabit = `Strong Reorder Habit (${repPct}% of customers come back to buy again)`;
    } else if ((storeSnapshot.orders?.repeat_customer_rate || 0) > 0.2) {
      const repStorePct = Math.round((storeSnapshot.orders?.repeat_customer_rate || 0) * 100);
      reorderHabit = `Healthy Store Repeat Rate (${repStorePct}% of all buyers return to order again)`;
    }

    const storeTopChannels = (storeSnapshot.orders?.acquisition_channels || [])
      .slice(0, 3)
      .map((c) => `${c.channel} (${c.percentage}%)`)
      .join(", ");

    const prompt = `Target Product Context:
- Product Title: ${targetTitle}
- Product Description: ${targetProductDescription}
- Category: ${targetProductType}
- Tags: ${targetProductTags}
- Price: ${targetProductPrice} ${storeCurrency}
- Product URL: ${targetProductUrl}
${siblingDenyList ? `\nForbidden Sibling Products (MUST NEVER appear by name or be referenced in any hook):\n${siblingDenyList}` : ""}

Product Performance & Customer Entry Signals:
- Role in Store: ${productRole}
- Primary Customer Traffic Channel: ${primaryTrafficSource}
- Top Store Acquisition Channels: ${storeTopChannels || "Direct / Organic Discovery"}
- Customer Reorder Habit: ${reorderHabit}

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
1. Product Role: This is ${targetTitle}, acting as ${productRole}. Frame your angles around the core emotional or practical trigger that compels cold prospects to buy for the first time.
2. Cold Acquisition Safeguard: Hook angles must have broad scroll-stopping appeal. Do NOT use hyper-narrow or hyper-local callouts that choke Meta's broad delivery algorithm.
3. Founder-Friendly Language: Speak directly to the founder in plain, actionable English without confusing corporate jargon or complex acronyms.
4. Meta Andromeda Timing: Frame timing guidance around weekly sales rhythm and cash-flow predictability (e.g. expected conversion volume surges). Never advise pausing or day-parting active campaigns, which resets Meta's machine learning.
5. Dynamic Location Intelligence: Analyze the merchant's home country (${storeCountry}), category (${targetProductType}), and unit price (${targetProductPrice} ${storeCurrency}). Infer domestic commercial hubs dynamically based on real urban purchasing power and e-commerce delivery viability in ${storeCountry}. If recommending international expansion, identify affluent global metro hubs with proven affinity for ${targetProductType} at this price point. Do not default to fixed or pre-assumed cities.
Generate a high-converting Advantage+ campaign brief for "${targetTitle}" following all rules in the system prompt. Call the generate_advantage_plus_profile tool.`;

    const response = await anthropicClient.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
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

    console.log("[Anthropic Prompt Caching - Standalone Brief]", {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      stop_reason: response.stop_reason,
      cache_creation_input_tokens:
        (response.usage as unknown as { cache_creation_input_tokens?: number })
          .cache_creation_input_tokens ?? 0,
      cache_read_input_tokens:
        (response.usage as unknown as { cache_read_input_tokens?: number })
          .cache_read_input_tokens ?? 0,
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
          max_tokens: 4096,
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
                )}\n\nPlease regenerate the profile strictly addressing these errors. Ensure exactly 3 distinct angles, zero references to sibling catalog items, and describe only "${targetTitle}".`,
            },
          ],
          tools: [ADVANTAGE_PLUS_TOOL],
          tool_choice: {
            type: "tool",
            name: "generate_advantage_plus_profile",
          },
        });

        console.log("[Anthropic Prompt Caching - Standalone Brief Retry]", {
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
