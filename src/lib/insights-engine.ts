import { StoreData } from "./store-data";
import Anthropic from "@anthropic-ai/sdk";
import { formatCurrency } from "@/lib/currency";
import { getExchangeRateCache, setExchangeRateCache } from "./db";

const anthropicClient = new Anthropic();
import { logApiUsage } from "@/lib/db";

// WARNING: NGN (Naira) is highly volatile.
// The 24-hour caching window may introduce meaningful variance in daily/monthly budget recommendations
// during periods of rapid rate fluctuations.
export async function fetchExchangeRates(): Promise<Record<string, number>> {
  try {
    const cached = await getExchangeRateCache();
    if (cached && cached.rates && cached.fetched_at) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).getTime();
      const fetchedAt = new Date(cached.fetched_at).getTime();
      if (fetchedAt > oneDayAgo) {
        return cached.rates as Record<string, number>;
      }
    }
  } catch (err) {
    console.error("Error reading exchange rates cache from database layer:", err);
  }

  // Cache miss or table not found/error: fetch from API
  try {
    console.log("Fetching fresh exchange rates from API...");
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const json = await res.json();
    const rates = json.rates as Record<string, number>;

    if (rates && typeof rates === "object") {
      try {
        await setExchangeRateCache(rates);
      } catch (cacheErr) {
        console.error("Database write exchange rate cache error:", cacheErr);
      }
      return rates;
    }
  } catch (err) {
    console.error("Failed to fetch fresh exchange rates from API:", err);
  }

  // Final fallback rates
  return {
    USD: 1,
    GBP: 0.8,
    EUR: 0.9,
    AED: 3.67,
    NGN: 1500,
    CAD: 1.4,
    AUD: 1.5,
    GHS: 15,
    KES: 130,
    ZAR: 19,
  };
}

export const CURRENCY_TO_REGION: Record<string, string> = {
  "NGN": "NG",
  "GBP": "GB",
  "EUR": "EU",
  "AED": "AE",
  "USD": "US",
  "CAD": "CA",
  "AUD": "AU",
  "GHS": "GH",
  "KES": "KE",
  "ZAR": "ZA",
};

export interface LocationResult {
  name: string;
  source: "from_data" | "recommended";
  percentage?: number | null;
  note?: string;
}

export interface TimingOutput {
  peak_days: string[];
  launch_recommendation: string;
  reasoning: string;
}

export interface TargetingProfile {
  locations: LocationResult[];
  demographics: {
    gender: "all" | "female" | "male";
    gender_reasoning: string;
    age_min: number;
    age_max: number;
    age_reasoning: string;
  };
  audiences: {
    interests: string[];
    interest_reasoning: string;
    behaviours: string[];
  };
  timing: TimingOutput;
  optimization_event: {
    event: string;
    reasoning: string;
    target_weekly: number;
    upgrade_milestone: string;
  };
}

/**
 * ─── 1. Consolidate AI Calls (Single-Pass Intelligence) ───
 * Makes a single call to Anthropic's Message API using structured tool use
 * to determine locations, demographics, and audience interests/behaviours.
 */
async function generateTargetingProfile(
  storeData: StoreData,
  adSets: number,
  dailyBudget: number,
  userId?: string | null
): Promise<TargetingProfile> {
  const storeCurrency = storeData.store?.currency || "USD";
  
  // Format top locations
  const consolidatedLocations = storeData.orders.top_locations
    .map((l) => `${l.city} (${l.percentage}%)`)
    .join(", ");

  // Take top 25 products enriched with category, tags, and revenue context
  const productSample = storeData.products
    .slice(0, 25)
    .map((p) => {
      const tags = (p.tags || []).slice(0, 5).join(", ");
      const type = p.product_type || p.collection || "";
      return [
        `- "${p.name}"`,
        `price: ${p.price} ${storeCurrency}`,
        type ? `category: ${type}` : null,
        tags ? `tags: ${tags}` : null,
        p.units_sold > 0 ? `units sold: ${p.units_sold}` : null,
      ].filter(Boolean).join(" | ");
    })
    .join("\n");

  const prompt = `You are a world-class Meta Ads media buyer and marketing consultant advising a busy fashion brand founder.
Analyze this Shopify store's data to generate a complete, high-converting targeting profile.

Store Details:
- Name: ${storeData.store.name}
- Domain: ${storeData.store.domain}
- Primary Market: ${storeData.store.country}
- Currency: ${storeCurrency}
- Rolling 60-day Average Order Value (AOV): ${Math.round(storeData.orders.average_order_value)} ${storeCurrency}

Top Buyer Locations (from order history):
${consolidatedLocations || "None recorded yet"}

Top Products (up to 25, with category, tags, and sales):
${productSample || "None available"}

Instructions for Reasoning & Messaging:
- Write like you're texting a busy fashion brand founder, not writing a report.
- Maximum one sentence for each reasoning / note / recommendation field.
- Never use jargon like "acquisition signal", "behavioral velocity", "cohort signals", or "units/mo velocity".
- Lead with the actionable implication, not the data behind it.
- If there's insufficient data, say so in plain English in under 6 words (e.g. "Too few sales to determine yet").
- Speak with the confidence of a smart marketer friend, not a dashboard tooltip.

Instructions for Locations:
- Include the store's top buyers' cities from the data, but also recommend 1-2 expansion hubs in their primary market if appropriate.
- For Nigerian locations: use city-level targeting only (Lagos, Abuja, Port Harcourt, Enugu) — never break down to neighbourhoods or areas, and never use "Nigeria" as a broad country target.
- For international locations: always use specific cities instead of broad countries — e.g. "New York, NY" or "Houston, TX", not "United States".
- Consolidate minor sub-cities into their parent metropolitan city.
- Keep the note field per location explaining whether it's from actual order data or recommended based on purchasing power for the price point.
- Mark each as source: "from_data" or "recommended".

Instructions for Demographics (Dynamic Age & Gender Selection):
- Determine the best target gender (all, female, male) and age range (min/max) dynamically based on the price points, styling, and design of the products in this store.
- Do NOT hardcode or default to generic ranges (like 25-44) unless the store data and product catalog actually dictate it.
- Higher AOV/price points should target older age ranges (e.g. 30-55) with more purchasing power; youth or streetwear brands should target younger age ranges (e.g. 18-34). Ensure min age is at least 18.

Instructions for Audiences (Critical — Data-Derived Only):
- Always include "Online Shopping" as one of the interests — it is a universal Meta behavioral signal for e-commerce.
- Recommend 3-5 additional highly specific Meta Ads interest targets derived DIRECTLY from the store's actual product names, categories, and tags listed above.
- Do NOT fill the remaining slots with generic fashion interests like "Fashion", "ASOS", or "Zara" unless the store's products specifically compete with those brands.
- Each additional interest must be a real, targetable Meta Ads interest. Derive it from the specific product styles, fabric types, design aesthetics, cultural references, or brand tier visible in the product list.
- Also always include "Engaged Shoppers" and "Online Shoppers" as baseline Meta behavioural targets — these are non-negotiable for any e-commerce campaign. Then recommend 1-2 additional behaviours that are specific to the nature of this store's products and target audience (e.g. "Luxury Goods" buyers, "Frequent Travellers", "Health & Wellness" enthusiasts — only if the store data actually supports it).
- interest_reasoning should reference 1-2 actual product names or tags from the list to justify the store-specific choices.

Instructions for Timing & Launches (Dynamic Campaign Launches):
- Analyze the store's peak days of orders: [${storeData.orders.peak_days.join(", ") || "None recorded yet"}].
- Analyze the store's peak hours of orders: [${storeData.orders.peak_hours.join(", ") || "None recorded yet"}].
- Generate dynamic, AI-inferred timing and campaign launch date recommendation. Write a highly actionable 1-sentence launch recommendation (e.g., "Launch Sunday evening to capture the strong Monday peak buying momentum").
- Write a 1-sentence reasoning explaining this launch schedule based on the peak hour/day trends.
- Populate "peak_days" with the primary peak day(s) detected or recommended.

Instructions for Optimization Event (Critical — Do Not Hardcode):
- The core question is: "Can Meta get enough optimization events per week to exit the learning phase given this store's budget and order velocity?"
- Use this logic internally to reason:
  - weeklyOrderVelocity = (monthly orders / 4)
  - estimatedWeeklyEventsAtBudget = weeklyOrderVelocity * (dailyBudget / avgOrderValue) * 7
- Walk down the event hierarchy (Purchase → InitiateCheckout → AddToCart → AddToWishlist → ViewContent) and select the highest event where estimatedWeeklyEventsAtBudget is likely to generate at least 10 events per week (10 is the realistic minimum for a small brand to see meaningful optimization signal).
- If the store has any purchase history at all, always try Purchase first before downgrading — a store with 8 monthly orders running a focused high budget can still generate purchase signal.
- Provide a plain English explanation of why this event makes sense to the merchant specifically stating what signal you expect and what to watch for.
- Also suggest a milestone to upgrade to the next level.

Campaign Context:
- Monthly Orders: ${storeData.orders.orders_last_30_days || 0}
- Recommended Ad Sets: ${adSets}
- Daily Budget per Ad Set: ${dailyBudget} ${storeCurrency}
`;

  try {
    const response = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          name: "generate_targeting_profile",
          description: "Generates the targeting profile for a Shopify store's Meta ad campaigns.",
          input_schema: {
            type: "object",
            properties: {
              locations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "City or region name" },
                    source: { type: "string", enum: ["from_data", "recommended"] },
                    percentage: { type: "number", description: "Percentage of orders from this location, or null if recommended" },
                    note: { type: "string", description: "Actionable 1-sentence note for the founder." }
                  },
                  required: ["name", "source", "percentage", "note"]
                }
              },
              demographics: {
                type: "object",
                properties: {
                  gender: { type: "string", enum: ["all", "female", "male"] },
                  gender_reasoning: { type: "string", description: "Actionable 1-sentence explanation of the gender selection." },
                  age_min: { type: "number", description: "Minimum age target (at least 18)" },
                  age_max: { type: "number", description: "Maximum age target (typically 44, 54, or 65)" },
                  age_reasoning: { type: "string", description: "Actionable 1-sentence explanation of the age selection." }
                },
                required: ["gender", "gender_reasoning", "age_min", "age_max", "age_reasoning"]
              },
              audiences: {
                type: "object",
                properties: {
                  interests: { type: "array", items: { type: "string" }, description: "Specific Meta Ads interest targets" },
                  interest_reasoning: { type: "string", description: "Actionable 1-sentence explanation of why these interests convert best." },
                  behaviours: { type: "array", items: { type: "string" }, description: "Target behaviors (e.g. ['Engaged Shoppers'])" }
                },
                required: ["interests", "interest_reasoning", "behaviours"]
              },
              timing: {
                type: "object",
                properties: {
                  peak_days: { type: "array", items: { type: "string" }, description: "Specific peak days detected or recommended" },
                  launch_recommendation: { type: "string", description: "Dynamic, AI-inferred launch recommendation." },
                  reasoning: { type: "string", description: "1-sentence explanation of why this launch timing works best." }
                },
                required: ["peak_days", "launch_recommendation", "reasoning"]
              },
              optimization_event: {
                type: "object",
                properties: {
                  event: { type: "string", description: "The recommended Meta Ads optimization event (e.g. Purchase, AddToCart, ViewContent)." },
                  reasoning: { type: "string", description: "Plain english explanation of why this event was chosen given budget and velocity." },
                  target_weekly: { type: "number", description: "The target number of events per week expected or required." },
                  upgrade_milestone: { type: "string", description: "A milestone suggestion for when to upgrade to a deeper funnel event." }
                },
                required: ["event", "reasoning", "target_weekly", "upgrade_milestone"]
              }
            },
            required: ["locations", "demographics", "audiences", "timing", "optimization_event"]
          }
        }
      ],
      tool_choice: {
        type: "tool",
        name: "generate_targeting_profile"
      }
    });

    const toolUseBlock = response.content.find((c) => c.type === "tool_use");
    if (toolUseBlock && toolUseBlock.type === "tool_use") {
      const profile = toolUseBlock.input as any;
      // Log raw AI output for debugging targeting quality
      console.log("[AI targeting profile raw output]", JSON.stringify(profile, null, 2));
      
      if (userId) {
        logApiUsage(
          userId,
          "targeting_profile",
          response.usage.input_tokens,
          response.usage.output_tokens
        );
      }

      if (profile && profile.locations && profile.demographics && profile.audiences && profile.timing) {
        return profile as TargetingProfile;
      } else {
        console.warn("[AI targeting profile] Tool returned incomplete data:", JSON.stringify(profile));
      }
    } else {
      console.warn("[AI targeting profile] No tool_use block found in response. Full response:", JSON.stringify(response.content));
    }
  } catch (err) {
    console.error("AI targeting profile generation error:", err);
  }

  // Fallback defaults in case of API failure or tool parsing error
  const defaultLocations = storeData.orders.top_locations.length > 0
    ? storeData.orders.top_locations.map(l => ({
        name: l.city,
        source: "from_data" as const,
        percentage: l.percentage,
        note: `Top buyer hub representing ${l.percentage}% of your customer orders.`
      }))
    : [
        {
          name: storeData.store.country || "Lagos",
          source: "from_data" as const,
          percentage: 100,
          note: "Defaulting targeting to your store's home market."
        }
      ];

  return {
    locations: defaultLocations,
    demographics: {
      gender: "all",
      gender_reasoning: "We recommend starting with broad gender targeting to let Meta's pixel learn your buyer profile.",
      age_min: 25,
      age_max: 44,
      age_reasoning: "Standard e-commerce age targeting (25-44) is highly recommended for early validation campaigns."
    },
    audiences: {
      interests: ["Online shopping", "Fashion"],
      interest_reasoning: "Broad fashion interest targeting is the most reliable way to feed early-stage customer data to the Meta pixel.",
      behaviours: ["Engaged Shoppers"]
    },
    timing: {
      peak_days: storeData.orders.peak_days.length > 0 ? storeData.orders.peak_days : ["Thursday"],
      launch_recommendation: storeData.orders.peak_days.length > 0
        ? `Launch on ${storeData.orders.peak_days[0]} morning to ride the buying momentum.`
        : "Launch on Thursday evening to capture weekend traffic.",
      reasoning: storeData.orders.peak_days.length > 0
        ? `Order data shows a clear conversion lift on ${storeData.orders.peak_days.join(", ")}.`
        : "Thursday launches build optimal momentum for weekend e-commerce traffic."
    },
    optimization_event: {
      event: "Add to Cart",
      reasoning: "A safe fallback event while the AI evaluates your full data.",
      target_weekly: 10,
      upgrade_milestone: "Switch to Purchase optimization once you get 10+ orders."
    }
  };
}

// ─── Health Scoring Functions (Unchanged) ───

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
    status: products.length >= 10 ? "good" : products.length >= 5 ? "warning" : "bad",
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
  const ratio =
    products.filter((p) => p.in_stock).length / products.length;
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
  targeting: {
    locations: LocationResult[];
    age_min: number;
    age_max: number;
    age_reasoning: string;
    gender: "all" | "female" | "male";
    gender_reasoning?: string;
    interests: string[];
    behaviours: string[];
    interest_reasoning: string;
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
  userId?: string | null
): Promise<MetaRecommendations> {
  const storeCurrency = storeData.store.currency || "USD";
  const rates = dynamicExchangeRates || (await fetchExchangeRates());
  const exchangeRate = rates[storeCurrency] || 1;

  // ─── Before running calculations: data sufficiency check ───
  if (storeData.orders.order_count < 20) {
    return {
      lowDataWarning: true,
      lowDataMessage: "We need at least 20 orders to generate reliable recommendations. Keep selling and check back soon.",
      targeting: {
        locations: storeData.orders.top_locations.length > 0
          ? storeData.orders.top_locations.map(l => ({
              name: l.city,
              source: "from_data" as const,
              percentage: l.percentage,
              note: `Top buyer city representing ${l.percentage}% of your customer orders.`
            }))
          : [{ name: storeData.store.country || "Lagos", source: "from_data" as const, percentage: 100, note: "Defaulting targeting to your store's home market." }],
        age_min: 25,
        age_max: 44,
        age_reasoning: "We need at least 20 orders to infer target age range.",
        gender: "all",
        gender_reasoning: "We recommend starting with broad gender targeting to let Meta's pixel learn your buyer profile.",
        interests: ["Online shopping", "Fashion"],
        behaviours: ["Engaged Shoppers"],
        interest_reasoning: "Starting with broad interest targeting is recommended for stores with low order volume.",
      },
      budget: {
        recommended_daily: Math.round(15 * exchangeRate),
        recommended_duration_days: 14,
        reasoning: "We need at least 20 orders to calculate personalized budgets. Using default minimal testing budget.",
        currency: storeCurrency,
        currency_symbol: storeData.store.currency_symbol || "$",
        tier: "Starter",
        ad_sets: 2,
        optimization_event: {
          event: "Add to Cart",
          reasoning: "Recommended for early testing with limited purchase data.",
          target_weekly: 30
        },
        breakdown: {
          revenue_based: 0,
          aov_based: storeData.orders.average_order_value || 0,
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
            total_daily: Math.round(15 * exchangeRate * 0.7) * 2,
            description: "Low risk, slow learning. Good if you're testing for the first time."
          },
          {
            label: "Sweet Spot",
            daily: Math.round(15 * exchangeRate * 1.0),
            total_daily: Math.round(15 * exchangeRate * 1.0) * 2,
            description: "Our recommendation. Enough budget for Meta to learn without burning cash."
          },
          {
            label: "Full Send",
            daily: Math.round(15 * exchangeRate * 1.4),
            total_daily: Math.round(15 * exchangeRate * 1.4) * 2,
            description: "Faster results but higher daily spend. Best when you already know your creative works."
          }
        ]
      },
      timing: {
        peak_days: [],
        launch_recommendation: "Launch anytime — gather data from your first campaign to optimise timing",
        reasoning: "No peak day data yet",
      },
      placements: {
        recommended: ["Facebook Feed", "Instagram Feed", "Instagram Stories", "Instagram Reels"]
      },
      top_products_to_advertise: storeData.products.filter(p => p.should_advertise).slice(0, 5).map(p => p.name),
      products_to_avoid: storeData.products.filter(p => !p.should_advertise).map(p => p.name),
      store_health_score: 20,
      health_breakdown: [
        { label: "Active Products", score: 5, max: 20, status: "warning", percentage: 25 },
        { label: "Recent Orders", score: 5, max: 30, status: "bad", percentage: 16 },
        { label: "Customer Retention", score: 5, max: 25, status: "bad", percentage: 20 },
        { label: "Product Availability", score: 5, max: 25, status: "bad", percentage: 20 }
      ],
      warnings: ["We need at least 20 orders to generate reliable recommendations. Keep selling and check back soon."],
      opportunities: []
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
      newStoreCautionMessage = "Your store is new — these recommendations will improve as more order data comes in.";
    }
  }

  // ── Dynamic Ad Sets: based on data maturity, not hardcoded ──
  const monthlyOrders = storeData.orders.orders_last_30_days || 0;
  let adSets: number;
  let adSetReasoning: string;

  if (monthlyOrders < 20) {
    adSets = 1;
    adSetReasoning = `Your ${monthlyOrders} monthly orders aren't enough to split test — start with 1 ad set to concentrate your data.`;
  } else if (monthlyOrders <= 50) {
    adSets = 2;
    adSetReasoning = `Your ${monthlyOrders} monthly orders give you enough signal to test 2 audience variations — run 1-2 ad sets.`;
  } else {
    adSets = 3;
    adSetReasoning = `With ${monthlyOrders} monthly orders, you have enough purchase volume to run meaningful split tests across 3 ad sets.`;
  }

  // ── BUDGET CALCULATION (USD tiered revenue ratio with AOV liquidity guardrail) ──
  const avgMonthlyRevenue = (storeData.orders as any).revenue_avg_3_months || storeData.orders.revenue_last_30_days || 0;
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
  const tierDailyPerAdSetUSD = totalDailySpendUSD / adSets; // raw tier budget per ad set

  // ── AOV Guardrail: only apply if within 2x of tier budget; warn if it would exceed 3x ──
  const aovUSD = storeData.orders.average_order_value / exchangeRate;
  const aovGuardrailUSD = aovUSD * 0.5; // minimum spend Meta needs to see a purchase signal

  let finalDailyPerAdSetUSD: number;
  let budgetWarning = false;
  let budgetWarningMessage: string | undefined;

  if (aovGuardrailUSD > tierDailyPerAdSetUSD * 3) {
    // Guardrail is unaffordable — use tier budget as-is and warn the merchant
    finalDailyPerAdSetUSD = tierDailyPerAdSetUSD;
    budgetWarning = true;
    const guardrailLocal = Math.round(aovGuardrailUSD * exchangeRate);
    const tierLocal = Math.round(tierDailyPerAdSetUSD * exchangeRate);
    budgetWarningMessage = `Your product price point ideally requires ${storeData.store.currency_symbol || ""}${guardrailLocal.toLocaleString()}/day per ad set for Meta's algorithm to work efficiently. Starting at ${storeData.store.currency_symbol || ""}${tierLocal.toLocaleString()} is possible but expect a longer learning phase. Consider starting with Add to Cart optimization instead of Purchase.`;
  } else if (aovGuardrailUSD > tierDailyPerAdSetUSD) {
    // Guardrail is within reason (1x–3x) — apply it
    finalDailyPerAdSetUSD = aovGuardrailUSD;
  } else {
    // Tier budget already covers the guardrail
    finalDailyPerAdSetUSD = tierDailyPerAdSetUSD;
  }

  const recommendedDailyLocal = finalDailyPerAdSetUSD * exchangeRate;
  const recommendedDaily = Math.round(recommendedDailyLocal);


  // Run unified AI single-pass call
  const profile = await generateTargetingProfile(storeData, adSets, recommendedDaily, userId);

  // --- TARGETING ---
  const gender = profile.demographics.gender;
  const gender_reasoning = profile.demographics.gender_reasoning;
  const finalAgeMin = profile.demographics.age_min || 25;
  const finalAgeMax = profile.demographics.age_max || 44;
  const finalAgeReasoning = profile.demographics.age_reasoning || "Standard e-commerce age targeting (25-44) is highly recommended for early validation campaigns.";
  
  const locations = profile.locations;
  const interests = profile.audiences.interests;
  const behaviours = profile.audiences.behaviours;
  const interest_reasoning = profile.audiences.interest_reasoning;

  // Goal multipliers (applied client-side, stored for reference)
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
      daily: Math.round(finalDailyPerAdSetUSD * 0.7 * exchangeRate),
      total_daily: Math.round(finalDailyPerAdSetUSD * 0.7 * exchangeRate) * adSets,
      description: "Low risk, slow learning. Good if you're testing for the first time."
    },
    {
      label: "Sweet Spot",
      daily: recommendedDaily,
      total_daily: recommendedDaily * adSets,
      description: "Our recommendation. Enough budget for Meta to learn without burning cash."
    },
    {
      label: "Full Send",
      daily: Math.round(finalDailyPerAdSetUSD * 1.4 * exchangeRate),
      total_daily: Math.round(finalDailyPerAdSetUSD * 1.4 * exchangeRate) * adSets,
      description: "Faster results but higher daily spend. Best when you already know your creative works."
    }
  ];

  let budgetReasoning = `Based on your monthly store revenue of ${formatCurrency(Math.round(avgMonthlyRevenue), storeCurrency, storeData.store.currency_symbol)}, ` +
    `we recommend ${adSets} ad set${adSets > 1 ? "s" : ""} at ${formatCurrency(recommendedDaily, storeCurrency, storeData.store.currency_symbol)} per ad set/day. ` +
    adSetReasoning;

  // Check high budget warning (for budgets that are genuinely high in absolute terms, post-guardrail)
  let highBudgetWarning = false;
  let highBudgetWarningMessage: string | undefined;

  if (!budgetWarning && finalDailyPerAdSetUSD > 50) {
    highBudgetWarning = true;
    const formattedAmount = formatCurrency(recommendedDaily, storeCurrency, storeData.store.currency_symbol);
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

  // --- STORE HEALTH (percentage-based) ---
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
      percentage: Math.round((availabilityScore.score / availabilityScore.max) * 100),
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

  return {
    ...(lowDataWarningCheck(storeData) ? {} : {
      newStoreCaution,
      newStoreCautionMessage,
      highBudgetWarning,
      highBudgetWarningMessage,
      budgetWarning,
      budgetWarningMessage,
    }),
    targeting: {
      locations,
      age_min: finalAgeMin,
      age_max: finalAgeMax,
      age_reasoning: finalAgeReasoning,
      gender,
      gender_reasoning,
      interests,
      behaviours,
      interest_reasoning,
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
        event: profile.optimization_event.event,
        reasoning: profile.optimization_event.reasoning,
        target_weekly: profile.optimization_event.target_weekly,
        upgrade_milestone: profile.optimization_event.upgrade_milestone,
      },
      ad_set_reasoning: adSetReasoning,
      breakdown: {
        revenue_based: avgMonthlyRevenue,
        aov_based: storeData.orders.average_order_value,
        goal_multipliers: goalMultipliers,
        meta_optimal_daily: strategies[0].daily,
      },
      strategies,
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
