import { StoreData } from "./store-data";
import Anthropic from "@anthropic-ai/sdk";

export interface MetaRecommendations {
  targeting: {
    locations: string[];
    age_min: number;
    age_max: number;
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
  timing: {
    best_days: string[];
    best_hours: string;
    reasoning: string;
  };
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

// ----- AI Interest Inference -----

async function inferInterests(
  storeData: StoreData
): Promise<{ interests: string[]; reasoning: string }> {
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
      message.content[0].type === "text" ? message.content[0].text : "";
    const interests = JSON.parse(text.trim()) as string[];

    // Build reasoning
    const reasoning = `Interests selected based on product catalogue: ${productList.slice(0, 80)}${productList.length > 80 ? "..." : ""}`;

    return { interests, reasoning };
  } catch (error) {
    console.error("Interest inference error:", error);
    return {
      interests: [],
      reasoning: "Could not infer interests — add them manually in Meta Ads Manager",
    };
  }
}

// ----- Scoring Helpers -----

function scoreProducts(products: StoreData["products"]): {
  score: number;
  status: "good" | "warning" | "bad";
} {
  const count = products.length;
  if (count >= 10) return { score: 25, status: "good" };
  if (count >= 5) return { score: 15, status: "warning" };
  if (count >= 1) return { score: 5, status: "bad" };
  return { score: 0, status: "bad" };
}

function scoreOrders(orderCount: number): {
  score: number;
  status: "good" | "warning" | "bad";
} {
  if (orderCount >= 20) return { score: 25, status: "good" };
  if (orderCount >= 5) return { score: 15, status: "warning" };
  if (orderCount >= 1) return { score: 5, status: "bad" };
  return { score: 0, status: "bad" };
}

function scoreRetention(repeatRate: number): {
  score: number;
  status: "good" | "warning" | "bad";
} {
  if (repeatRate > 0.3) return { score: 25, status: "good" };
  if (repeatRate > 0.1) return { score: 15, status: "warning" };
  if (repeatRate > 0.01) return { score: 5, status: "bad" };
  return { score: 0, status: "bad" };
}

function scoreAvailability(products: StoreData["products"]): {
  score: number;
  status: "good" | "warning" | "bad";
} {
  if (products.length === 0) return { score: 0, status: "bad" };
  const inStockPercent =
    products.filter((p) => p.in_stock).length / products.length;
  if (inStockPercent > 0.8) return { score: 25, status: "good" };
  if (inStockPercent > 0.5) return { score: 15, status: "warning" };
  if (inStockPercent > 0.2) return { score: 5, status: "bad" };
  return { score: 0, status: "bad" };
}

// ----- Main Engine -----

export async function generateRecommendations(
  storeData: StoreData
): Promise<MetaRecommendations> {
  // --- TARGETING ---

  // Locations — derived from data
  const locations = storeData.orders.top_locations
    .filter((l) => l.percentage > 5)
    .map((l) => `${l.city}, ${l.country}`);

  // Age & Gender — no data from Shopify, flag as unknown
  const age_min = 0;
  const age_max = 0;
  const gender: "all" | "female" | "male" = "all";

  // Interests — AI inferred
  const { interests, reasoning: interestReasoning } =
    await inferInterests(storeData);

  // Behaviours — universal
  const behaviours = ["Engaged Shoppers", "Online Shoppers"];

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
  const peakHours = storeData.orders.peak_hours;
  let bestHoursLabel = "No order data yet";
  let timingReasoning = "No order data yet";

  if (peakHours.length > 0) {
    const primaryHour = peakHours[0];
    if (primaryHour >= 0 && primaryHour < 12) {
      bestHoursLabel = "Morning (6am-12pm)";
    } else if (primaryHour >= 12 && primaryHour < 17) {
      bestHoursLabel = "Afternoon (12pm-5pm)";
    } else if (primaryHour >= 17 && primaryHour < 22) {
      bestHoursLabel = "Evening (5pm-10pm)";
    } else {
      bestHoursLabel = "Night (10pm-2am)";
    }
    timingReasoning = `Most orders happen ${bestHoursLabel.toLowerCase()} on ${storeData.orders.peak_days.join(", ")}`;
  }

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
  const retentionScore = scoreRetention(
    storeData.orders.repeat_customer_rate
  );
  const availabilityScore = scoreAvailability(storeData.products);

  const healthBreakdown = [
    {
      label: "Active Products",
      score: productScore.score,
      max: 25,
      status: productScore.status,
    },
    {
      label: "Recent Orders",
      score: orderScore.score,
      max: 25,
      status: orderScore.status,
    },
    {
      label: "Customer Retention",
      score: retentionScore.score,
      max: 25,
      status: retentionScore.status,
    },
    {
      label: "Product Availability",
      score: availabilityScore.score,
      max: 25,
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
  const outOfStockCount = storeData.products.filter(
    (p) => !p.in_stock
  ).length;
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
      age_min,
      age_max,
      gender,
      interests,
      behaviours,
      interest_reasoning: interestReasoning,
    },
    budget: {
      recommended_daily_ngn: recommendedDaily,
      recommended_duration_days: 7,
      reasoning: budgetReasoning,
    },
    timing: {
      best_days: storeData.orders.peak_days,
      best_hours: bestHoursLabel,
      reasoning: timingReasoning,
    },
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
