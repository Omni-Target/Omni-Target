import { StoreData } from "./store-data";
import Anthropic from "@anthropic-ai/sdk";

// ─── FIX 1: City → State mapping ────────────────────────────────────────────

const NIGERIA_CITY_TO_STATE: Record<string, string> = {
  // Lagos areas
  surulere: "Lagos",
  ikoyi: "Lagos",
  lekki: "Lagos",
  yaba: "Lagos",
  ikeja: "Lagos",
  "victoria island": "Lagos",
  ajah: "Lagos",
  "lagos island": "Lagos",
  festac: "Lagos",
  "isale eko": "Lagos",
  mushin: "Lagos",
  ojodu: "Lagos",
  magodo: "Lagos",
  gbagada: "Lagos",
  maryland: "Lagos",
  // Abuja areas
  garki: "Abuja",
  wuse: "Abuja",
  maitama: "Abuja",
  asokoro: "Abuja",
  gwarinpa: "Abuja",
  abuja: "Abuja",
  // Other states
  "port harcourt": "Rivers",
  ph: "Rivers",
  enugu: "Enugu",
  kano: "Kano",
  ibadan: "Oyo",
  benin: "Edo",
  "benin city": "Edo",
  warri: "Delta",
  owerri: "Imo",
  calabar: "Cross River",
};

const HIGH_PERFORMANCE_STATES = ["Lagos", "Abuja", "Rivers"];

export interface LocationEntry {
  name: string;
  source: "from_data" | "recommended";
  percentage?: number;
}

function buildLocations(
  topLocations: StoreData["orders"]["top_locations"]
): LocationEntry[] {
  const stateMap = new Map<string, number>(); // state → max percentage

  // Map each city to its state and accumulate percentages
  for (const loc of topLocations) {
    const key = loc.city.toLowerCase().trim();
    const state = NIGERIA_CITY_TO_STATE[key] ?? loc.city;
    const existing = stateMap.get(state) ?? 0;
    stateMap.set(state, Math.max(existing, loc.percentage));
  }

  const results: LocationEntry[] = [];

  // Add data-derived states
  for (const [state, pct] of stateMap.entries()) {
    results.push({ name: state, source: "from_data", percentage: pct });
  }

  // Add high-performance states not already present
  for (const state of HIGH_PERFORMANCE_STATES) {
    if (!stateMap.has(state)) {
      results.push({ name: state, source: "recommended" });
    }
  }

  return results;
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
    const productSample = storeData.products
      .slice(0, 5)
      .map((p) => `${p.name} — ₦${p.price.toLocaleString()}`)
      .join("\n");

    const agePrompt = `You are a consumer research analyst.
Based on these products and their price points, estimate the most likely buyer age range that would convert for Meta ads.

Products:
${productSample}

Store AOV: ₦${Math.round(storeData.orders.average_order_value)}

Return ONLY a JSON object, no markdown:
{"age_min": number, "age_max": number, "reasoning": "one sentence explanation"}`;

    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 128,
      messages: [{ role: "user", content: agePrompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const parsed = JSON.parse(text) as {
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
    const productSample = storeData.products
      .slice(0, 5)
      .map((p) => `${p.name} — ₦${p.price.toLocaleString()}`)
      .join("\n");

    const behaviourPrompt = `You are a Meta Ads specialist.
Based on these products from a Shopify store, suggest 4-6 relevant Facebook audience behaviours to target.

Only suggest behaviours that actually exist in Meta Ads Manager audience targeting.

Products:
${productSample}
Store AOV: ₦${Math.round(storeData.orders.average_order_value)}

Always include:
- "Engaged Shoppers"
- "Online shoppers"

Then add 2-4 more that fit this specific store type.

Return ONLY a JSON array of strings. No explanation. No markdown.
Example: ["Engaged Shoppers", "Online shoppers", "Fashion enthusiasts"]`;

    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 128,
      messages: [{ role: "user", content: behaviourPrompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const behaviours = JSON.parse(text) as string[];

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
  // Defensive check
  if (!storeData.products || storeData.products.length === 0) {
    return {
      interests: [],
      interest_reasoning: "No products found in store",
    };
  }

  console.log(
    "Generating interests for products:",
    storeData.products.slice(0, 5).map((p) => p.name)
  );

  try {
    const productList = storeData.products
      .slice(0, 10)
      .map((p) => p.name)
      .join(", ");

    const prompt = `You are a Meta Ads specialist.
Based on these product names from a Shopify store, suggest 5-8 relevant Facebook/Instagram interest categories to target. Only suggest interests that actually exist in Meta Ads Manager.

Products: ${productList}
Store revenue last 30 days: ${storeData.orders.revenue_last_30_days}
Top customer locations: ${storeData.orders.top_locations.map((l) => l.city).join(", ")}

Return ONLY a JSON array of strings.
No explanation. No markdown.
Example: ["Fashion", "Online shopping", "Luxury goods"]`;

    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const interests = JSON.parse(text) as string[];

    const reasoning = `Interests selected based on product catalogue: ${productList.slice(0, 80)}${productList.length > 80 ? "..." : ""}`;
    return { interests, interest_reasoning: reasoning };
  } catch (error) {
    console.error("Interest inference error:", error);
    return {
      interests: [],
      interest_reasoning:
        "Could not infer interests — add them manually in Meta Ads Manager",
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
    reasoning: `Most orders happen on ${peakDays.join(", ")}${hoursLabel}`,
  };
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface MetaRecommendations {
  targeting: {
    locations: LocationEntry[];
    age_min: number;
    age_max: number;
    age_reasoning: string;
    gender: "all" | "female" | "male";
    interests: string[];
    behaviours: string[];
    interest_reasoning: string;
  };
  budget: {
    recommended_daily_ngn: number;
    recommended_duration_days: number;
    reasoning: string;
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
  }[];
  warnings: string[];
  opportunities: string[];
}

// ─── Main Engine ──────────────────────────────────────────────────────────────

export async function generateRecommendations(
  storeData: StoreData
): Promise<MetaRecommendations> {
  // Run AI calls in parallel for speed
  const [{ interests, interest_reasoning }, ageRange, behaviours] =
    await Promise.all([
      inferInterests(storeData),
      inferAgeRange(storeData),
      inferBehaviours(storeData),
    ]);

  // --- TARGETING ---
  const locations = buildLocations(storeData.orders.top_locations);
  const gender: "all" | "female" | "male" = "all";

  // --- BUDGET ---
  const monthlyRevenue = storeData.orders.revenue_last_30_days;
  const orderCount = storeData.orders.orders_last_30_days;

  let recommendedDaily: number;
  let budgetReasoning: string;

  if (orderCount === 0) {
    recommendedDaily = 3000;
    budgetReasoning =
      "Starting budget for a new campaign with no historical data";
  } else {
    const tenPercent = monthlyRevenue * 0.1;
    const dailyFromRevenue = Math.round(tenPercent / 30);
    recommendedDaily = Math.min(Math.max(dailyFromRevenue, 3000), 50000);
    budgetReasoning = `Based on ₦${Math.round(monthlyRevenue / 1000)}k revenue last 30 days. 10% of monthly revenue ÷ 30 days = ₦${recommendedDaily.toLocaleString()}/day test budget.`;
  }

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
    },
    {
      label: "Recent Orders",
      score: orderScore.score,
      max: orderScore.max,
      status: orderScore.status,
    },
    {
      label: "Customer Retention",
      score: retentionScore.score,
      max: retentionScore.max,
      status: retentionScore.status,
    },
    {
      label: "Product Availability",
      score: availabilityScore.score,
      max: availabilityScore.max,
      status: availabilityScore.status,
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
    warnings.push(
      `Low average order value (₦${Math.round(storeData.orders.average_order_value).toLocaleString()}) — ad costs may exceed profit per sale`
    );
  }

  // --- OPPORTUNITIES ---
  const opportunities: string[] = [];
  if (storeData.orders.repeat_customer_rate > 0.2) {
    opportunities.push(
      "High repeat customer rate detected — consider creating a Lookalike Audience from your existing customers"
    );
  }
  const weekendDays = ["Saturday", "Sunday"];
  const hasWeekendPeak = storeData.orders.peak_days.some((d) =>
    weekendDays.includes(d)
  );
  if (hasWeekendPeak) {
    opportunities.push(
      "Peak weekend buying detected — consider launching campaigns on Thursday to build momentum"
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
      age_min: ageRange.age_min,
      age_max: ageRange.age_max,
      age_reasoning: ageRange.reasoning,
      gender,
      interests,
      behaviours,
      interest_reasoning,
    },
    budget: {
      recommended_daily_ngn: recommendedDaily,
      recommended_duration_days: 7,
      reasoning: budgetReasoning,
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
