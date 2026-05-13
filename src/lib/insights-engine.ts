import { StoreData } from "./store-data";
import Anthropic from "@anthropic-ai/sdk";
import { formatCurrency } from "@/lib/currency";

const anthropicClient = new Anthropic();

// ─── FIX 1 & 2: Global Region & Currency Context ────────────────────────────

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

export const CURRENCY_MULTIPLIERS: Record<string, number> = {
  "USD": 1,
  "GBP": 0.8,
  "EUR": 0.9,
  "AED": 3.67,
  "NGN": 1500,
  "CAD": 1.4,
  "AUD": 1.5,
  "GHS": 15,
  "KES": 130,
  "ZAR": 19,
};

export interface LocationResult {
  name: string;
  source: "from_data" | "recommended";
  percentage?: number;
  note?: string;
}

async function buildLocationTargeting(
  storeData: StoreData
): Promise<LocationResult[]> {
  const storeCurrency = storeData.store?.currency || "USD";

  // Locations are already consolidated by the Shopify connector
  const consolidatedList = storeData.orders.top_locations
    .map((l) => `${l.city} (${l.percentage}%)`)
    .join(", ");

  const locationPrompt = `
You are a Meta Ads targeting specialist 
for a Shopify store.

Store currency: ${storeCurrency}
Orders from the last 90 days came 
from these locations:
${consolidatedList}

Your task:
1. Determine the store's primary market 
   from the currency and order patterns
2. For the primary market, consolidate 
   all sub-city areas into their 
   parent city or state only
   (e.g. Ikoyi + Lagos Island + Lekki 
   all become just "Lagos")
3. STRICTLY EXCLUDE locations outside the 
   primary market (e.g. US, Europe, etc). 
   You must REMOVE them from the final 
   output unless a single foreign city 
   represents > 20% of all orders. These 
   are diaspora orders and will ruin the 
   ad targeting if included.
4. After consolidation, recommend 
   1-2 additional HIGH VALUE cities 
   in the primary market that are NOT 
   in the order data but have strong 
   purchasing power for this type of store
5. Return maximum 4 locations total
6. NEVER list sub-city neighbourhoods 
   as separate targets

For Nigerian stores (NGN):
- Consolidate all Lagos areas → "Lagos"
- Consolidate all Abuja areas → "Abuja"  
- Add from: [Abuja, Port Harcourt, 
  Ibadan, Kano] if not present
- STRICTLY EXCLUDE: US cities (Detroit, Hanahan, etc), 
  European cities (Budapest, etc) unless 
  they individually > 20% of orders.

CRITICAL RULE: 
A city and its neighbourhoods must 
NEVER appear as separate entries.

If "Lagos" appears in the data, 
then "Ikoyi", "Lekki", "Victoria Island",
"Surulere", "Yaba", "Ikeja" and ALL 
other Lagos areas must be MERGED 
into "Lagos" and removed as 
separate entries.

If "Abuja" appears, then "Maitama", 
"Wuse", "Garki", "Asokoro", "Gwarinpa" 
must be merged into "Abuja".

If "Port Harcourt" appears, 
"GRA Port Harcourt", "Trans Amadi" 
must be merged into "Port Harcourt".

Think of it this way: a Meta ad 
targeting "Lagos" already reaches 
everyone in Ikoyi, Lekki, Victoria Island
and every other Lagos area. Listing 
them separately adds zero value and 
confuses the founder.

The MAXIMUM output is 4 city-level 
or country-level entries. Never 
sub-city areas.

Return ONLY valid JSON, no markdown:
{
  "primary_market": "Nigeria",
  "locations": [
    {
      "name": "Lagos",
      "source": "from_data",
      "percentage": 45,
      "note": null
    },
    {
      "name": "Abuja", 
      "source": "recommended",
      "percentage": null,
      "note": "High purchasing power"
    }
  ]
}
`;

  try {
    const message = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: locationPrompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const cleanText = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleanText) as {
      primary_market: string;
      locations: LocationResult[];
      excluded: string[];
    };

    if (Array.isArray(parsed.locations) && parsed.locations.length > 0) {
      return parsed.locations;
    }
    throw new Error("Invalid locations array");
  } catch (error) {
    console.error("Location targeting inference error:", error);
    return storeData.orders.top_locations.slice(0, 5).map(l => ({
      name: l.city,
      source: "from_data",
      percentage: l.percentage,
      note: "Manual review recommended"
    } as LocationResult));
  }
}

// ─── FIX 2: AI Gender Range ───────────────────────────────────────────────────

async function inferGender(storeData: StoreData): Promise<{ gender: "all" | "female" | "male"; reasoning: string }> {
  try {
    const genderPrompt = `
Based on these fashion products and 
their descriptions, determine the 
primary target gender for Meta ads.

  Products:
${
  storeData.products.slice(0, 20)
    .map(p => `${p.name}: ${p.description?.slice(0, 100) ||
      p.product_type || ""
      }`)
    .join("\n")
}

Return ONLY valid JSON, no markdown:
{
  "gender": "female" | "male" | "all",
    "confidence": "high" | "medium" | "low",
      "reasoning": "one sentence"
}

If products are clearly women's fashion: return "female"
If clearly men's: return "male"
If mixed or accessories: return "all"
  `;
    const message = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      messages: [{ role: "user", content: genderPrompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const cleanText = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleanText) as {
      gender: "all" | "female" | "male";
      reasoning: string;
    };

    if (["all", "female", "male"].includes(parsed.gender)) {
      return parsed;
    }
    return { gender: "all", reasoning: "AI inference unclear — defaulted to all genders" };
  } catch (error) {
    console.error("Gender inference error:", error);
    return { gender: "all", reasoning: "AI inference failed — using defaults" };
  }
}

// ─── FIX 2: AI Age Range ─────────────────────────────────────────────────────

async function inferAgeRange(
  storeData: StoreData
): Promise<{ age_min: number; age_max: number; reasoning: string }> {
  const fallback = {
    age_min: 22,
    age_max: 45,
    reasoning: "Default range — connect store for AI-estimated range",
  };

  try {
    const currency = storeData.store.currency || "USD";
    const storeRegion = CURRENCY_TO_REGION[currency] || "OTHER";

    const productSample = storeData.products
      .slice(0, 15)
      .map((p) => `${ p.name } — ${ p.price.toLocaleString() } ${ currency } `)
      .join("\n");

    const agePrompt = `
You are a consumer research analyst.
Based on these products and price points,
  estimate the most likely buyer age range
for Meta ads in ${ storeRegion } market.

  Products:
${ productSample }

Store AOV: ${
  Math.round(
    storeData.orders.average_order_value
  )
} ${ currency }

Return ONLY valid JSON, no markdown:
{
  "age_min": number,
    "age_max": number,
      "reasoning": "one sentence"
} `;

    const message = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      messages: [{ role: "user", content: agePrompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const cleanText = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleanText) as {
      age_min: number;
      age_max: number;
      reasoning: string;
    };

    if (
      typeof parsed.age_min === "number" &&
      typeof parsed.age_max === "number"
    ) {
      return parsed;
    }
    return fallback;
  } catch (error) {
    console.error("Age range inference error:", error);
    return fallback;
  }
}

// ─── FIX 3: AI Behaviour Suggestions ─────────────────────────────────────────

async function inferBehaviours(storeData: StoreData): Promise<string[]> {
  try {
    const currency = storeData.store.currency || "USD";
    const storeRegion = CURRENCY_TO_REGION[currency] || "OTHER";

    const productSample = storeData.products
      .slice(0, 25)
      .map((p) => p.name)
      .join(", ");

    const behaviourPrompt = `
You are a Meta Ads specialist.
  Suggest 4 - 6 Facebook audience behaviours 
to target for this store.

  Products: ${ productSample }
Store market: ${ storeRegion }
Store AOV: ${ Math.round(storeData.orders.average_order_value) } ${ currency }

ALWAYS include:
- "Engaged Shoppers"
  - "Online shoppers"

Add 2 - 4 more that are relevant 
to this specific store type.
For fashion brands consider:
fashion enthusiasts, style bloggers,
  luxury goods buyers, etc.

Return ONLY a JSON array of strings.
No markdown.No explanation.
  Example: ["Engaged Shoppers", "Online shoppers", "Fashion enthusiasts", "Luxury goods"]
    `;

    const message = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      messages: [{ role: "user", content: behaviourPrompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const cleanText = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const behaviours = JSON.parse(cleanText) as string[];

    if (Array.isArray(behaviours) && behaviours.length > 0) {
      return behaviours;
    }
    return ["Engaged Shoppers", "Online shoppers"];
  } catch (error) {
    console.error("Behaviour inference error:", error);
    return ["Engaged Shoppers", "Online shoppers"];
  }
}

// ─── FIX 4: AI Interest Inference (with defensive check + logging) ───────────

async function inferInterests(
  storeData: StoreData
): Promise<{ interests: string[]; interest_reasoning: string }> {
  console.log("Products for interests:", storeData?.products?.length);

  if (!storeData?.products?.length) {
    console.error("No products available for interest generation");
    return {
      interests: [
        "Fashion",
        "Online shopping",
        "Style"
      ],
      interest_reasoning: 
        "Default interests — store product data not available"
    };
  }

  try {
    const currency = storeData.store.currency || "USD";
    const storeRegion = CURRENCY_TO_REGION[currency] || "OTHER";

    const productSample = storeData.products
      .slice(0, 25)
      .map((p) => p.name)
      .join(", ");

    const prompt = `
You are a Meta Ads specialist.
Based on these products from a Shopify
store, suggest 5 - 8 relevant Facebook 
and Instagram interest categories.

Only suggest interests that actually
exist in Meta Ads Manager.

  Products: ${ productSample }
Store market: ${ storeRegion }
Store currency: ${ currency }
Store AOV: ${
  Math.round(
    storeData.orders.average_order_value
  )
} ${ currency }

Always include:
- "Online shopping"
  - "Fashion"

Add 3 - 6 more specific to these 
products and this market.
For ${
  storeRegion === "NG"
    ? "African market: consider African fashion, Lagos social scene where relevant"
    : storeRegion === "GB"
      ? "UK market: consider sustainable fashion, British style, Vogue UK readers where relevant"
      : storeRegion === "AE"
        ? "Gulf market: consider luxury fashion, modest fashion where relevant, Dubai lifestyle"
        : "global fashion audience"
}

Return ONLY a JSON array of strings.
No explanation.No markdown.
`;

    const message = await anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const cleanText = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const interests = JSON.parse(cleanText) as string[];

    const reasoning = `Interests selected based on product catalogue: ${ productSample.slice(0, 80) }${ productSample.length > 80 ? "..." : "" } `;
    return { interests, interest_reasoning: reasoning };
  } catch (interestError) {
    console.error("Interest generation failed:", interestError);
    return {
      interests: ["Fashion", "Online shopping"],
      interest_reasoning: "AI inference failed — using defaults",
    };
  }
}

// ─── FIX 5: Health score scoring helpers (percentage-based) ──────────────────

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

// ─── FIX 6: Timing reframing ─────────────────────────────────────────────────

interface TimingOutput {
  peak_days: string[];
  launch_recommendation: string;
  reasoning: string;
}

function buildTiming(
  peakDays: string[],
  peakHours: number[]
): TimingOutput {
  if (peakDays.length === 0) {
    return {
      peak_days: [],
      launch_recommendation:
        "Launch anytime — gather data from your first campaign to optimise timing",
      reasoning: "No peak day data yet",
    };
  }

  const weekendDays = ["Friday", "Saturday", "Sunday"];
  const mondayDays = ["Monday", "Tuesday"];
  const hasWeekendPeak = peakDays.some((d) => weekendDays.includes(d));
  const hasMondayPeak = peakDays.some((d) => mondayDays.includes(d));

  let launch_recommendation: string;
  if (hasWeekendPeak) {
    launch_recommendation =
      "Launch your campaign on Thursday evening to build momentum before your peak buying days";
  } else if (hasMondayPeak) {
    launch_recommendation =
      "Launch Sunday evening to catch your Monday buyers";
  } else {
    launch_recommendation =
      "Launch anytime — gather data from your first campaign to optimise timing";
  }

  // Build hours label for reasoning
  let hoursLabel = "";
  if (peakHours.length > 0) {
    const h = peakHours[0];
    if (h >= 0 && h < 12) hoursLabel = " in the morning";
    else if (h >= 12 && h < 17) hoursLabel = " in the afternoon";
    else if (h >= 17 && h < 22) hoursLabel = " in the evening";
    else hoursLabel = " at night";
  }

  return {
    peak_days: peakDays,
    launch_recommendation,
    reasoning: `Most orders happen on ${ peakDays.join(", ") }${ hoursLabel } `,
  };
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface MetaRecommendations {
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
    tier: "Starter" | "Testing" | "Growth" | "Scale";
    breakdown: {
      revenue_based: number;
      aov_based: number;
      goal_multipliers: Record<string, number>;
      meta_optimal_daily: number; 
    };
    strategies: {
      label: string;
      daily: number;
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
  storeData: StoreData
): Promise<MetaRecommendations> {
  // Run AI calls in parallel for speed
  const [{ interests, interest_reasoning }, ageRange, behaviours, genderRange, locations] =
    await Promise.all([
      inferInterests(storeData),
      inferAgeRange(storeData),
      inferBehaviours(storeData),
      inferGender(storeData),
      buildLocationTargeting(storeData),
    ]);

  // --- TARGETING ---
  const gender = genderRange.gender;
  const gender_reasoning = genderRange.reasoning;

  let finalAgeMin = ageRange.age_min;
  let finalAgeMax = ageRange.age_max;
  let finalAgeReasoning = ageRange.reasoning;

  if (finalAgeMin === 0 || finalAgeMax === 0) {
    finalAgeMin = 25;
    finalAgeMax = 44;
    finalAgeReasoning = "25 — 44 (AI estimated). Refine after your first campaign using Meta Audience Insights";
  } else {
    finalAgeReasoning = `${ finalAgeMin } — ${ finalAgeMax } (AI estimated from your products).` + finalAgeReasoning;
  }

  // --- BUDGET (Multi-Signal Engine) ---
  const monthlyRevenue = storeData.orders.revenue_last_30_days;
  const orderCount = storeData.orders.orders_last_30_days;
  const aov = storeData.orders.average_order_value;
  const storeCurrency = storeData.store.currency || "USD";

  // Normalize revenue to USD-equivalent for universal tier thresholds
  const currencyMultiplier = CURRENCY_MULTIPLIERS[storeCurrency] || 1;
  const revenueUSD = monthlyRevenue / currencyMultiplier;

  // Goal multipliers (applied client-side, stored for reference)
  const goalMultipliers: Record<string, number> = {
    "Drive Website Sales": 1.0,
    "Grow Brand Awareness": 0.6,
    "Promote a New Collection": 1.2,
    "Retarget Past Visitors": 0.4,
  };

  // ── Signal 1: Revenue-based budget ──
  let revenueBased: number;
  let budgetTier: "Starter" | "Testing" | "Growth" | "Scale";

  if (orderCount === 0 || monthlyRevenue === 0) {
    // No sales data — use a sensible starter in local currency
    revenueBased = Math.round(2 * currencyMultiplier); // ~$2/day equivalent
    budgetTier = "Starter";
  } else if (revenueUSD < 500) {
    // < $500/month equivalent
    revenueBased = Math.max(
      Math.round(monthlyRevenue * 0.08 / 30),
      Math.round(1.5 * currencyMultiplier) // min ~$1.50/day
    );
    budgetTier = "Testing";
  } else if (revenueUSD < 2000) {
    // $500–$2,000/month equivalent
    revenueBased = Math.round(monthlyRevenue * 0.10 / 30);
    budgetTier = "Growth";
  } else {
    // > $2,000/month equivalent
    revenueBased = Math.round(monthlyRevenue * 0.12 / 30);
    budgetTier = "Scale";
  }

  // ── BUDGET REWORK: 3-Month Revenue Average ──
  // Fallback to 30-day revenue if 3-month average isn't in the payload yet
  const avgMonthlyRevenue = (storeData.orders as any).revenue_avg_3_months || storeData.orders.revenue_last_30_days || 0;
  const storeCurrency = storeData.store.currency || "USD";
  const currencyMultiplier = CURRENCY_MULTIPLIERS[storeCurrency] || 1;

  // Limits (Normalized from NGN base)
  const MIN_DAILY_NGN = 3000;
  const MAX_DAILY_NGN = 50000;
  
  const minDaily = Math.round((MIN_DAILY_NGN / 1500) * currencyMultiplier); 
  const maxDaily = Math.round((MAX_DAILY_NGN / 1500) * currencyMultiplier);

  const calculateStrategy = (ratio: number) => {
    const rawDaily = (avgMonthlyRevenue * ratio) / 30;
    return Math.min(Math.max(Math.round(rawDaily), minDaily), maxDaily);
  };

  const strategies = [
    {
      label: "Performance (10%)",
      daily: calculateStrategy(0.10),
      description: `Aggressive testing spend using 10% of your average monthly revenue. Maxes at ${formatCurrency(maxDaily, storeCurrency)}/day for safety.`
    },
    {
      label: "Balanced (6%)",
      daily: calculateStrategy(0.06),
      description: `Optimal test spend using 6% of your average monthly revenue. Designed for sustainable data gathering.`
    },
    {
      label: "Conservative (3%)",
      daily: calculateStrategy(0.03),
      description: `Low-risk testing using 3% of your average monthly revenue. Minimum floor of ${formatCurrency(minDaily, storeCurrency)}/day applied.`
    }
  ];

  // Default to Balanced
  let recommendedDaily = strategies[1].daily;
  let budgetReasoning = `Based on your 3-month average revenue of ${formatCurrency(avgMonthlyRevenue, storeCurrency)}, we've calculated three spend ratios (3%, 6%, 10%) capped between ${formatCurrency(minDaily, storeCurrency)} and ${formatCurrency(maxDaily, storeCurrency)} per day. ` +
    `These are optimized for early-stage test campaigns to validate your product and creative without overspending.`;


// --- TIMING ---
const timing = buildTiming(
  storeData.orders.peak_days,
  storeData.orders.peak_hours
);

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

// --- STORE HEALTH (FIX 5: percentage-based) ---
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
if (
  storeData.orders.average_order_value > 0 &&
  storeData.orders.average_order_value < 5000
) {
  const currency = storeData.store.currency || "USD";
  warnings.push(
    `Low average order value (${Math.round(storeData.orders.average_order_value).toLocaleString()} ${currency}) — ad costs may exceed profit per sale`
  );
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
if (storeData.orders.average_order_value > 20000) {
  opportunities.push(
    "High average order value — consider premium interest targeting for higher-intent audiences"
  );
}

return {
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
    recommended_duration_days: 7,
    reasoning: budgetReasoning,
    currency: storeData.store?.currency || "USD",
    tier: budgetTier,
    breakdown: {
      revenue_based: avgMonthlyRevenue,
      aov_based: aov, // keep AOV as a signal for frontend display
      goal_multipliers: goalMultipliers,
      meta_optimal_daily: strategies[0].daily, // Performance strategy
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
