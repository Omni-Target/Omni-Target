export interface StoreProductScoreInput {
  in_stock: boolean;
  units_sold?: number;
  order_count?: number;
  gateway_classification?: string;
  name?: string;
}

export interface StoreOrdersScoreInput {
  orders_last_30_days?: number;
  repeat_customer_rate?: number;
  revenue_last_30_days?: number;
  average_order_value?: number;
}

export interface AdReadinessBreakdown {
  products: number;
  orders: number;
  retention: number;
  availability: number;
}

export interface AdReadinessScoreResult {
  totalScore: number;
  breakdown: AdReadinessBreakdown;
  status: "healthy" | "moderate" | "needs_attention";
}

/**
 * Canonical 0–100 Ad Readiness scoring formula used across both the
 * Onboarding Store Audit and the Command Center Dashboard hero.
 *
 * Evaluates 4 pillars (25 points each = 100 total):
 * 1. Product catalog depth (up to 25 pts)
 * 2. Sales velocity in last 30 days (up to 25 pts)
 * 3. Customer retention / repeat purchase rate (up to 25 pts)
 * 4. Inventory in-stock availability ratio (up to 25 pts)
 */
export function calculateAdReadinessScore(
  products: StoreProductScoreInput[] = [],
  orders: StoreOrdersScoreInput = {},
): AdReadinessScoreResult {
  const totalProducts = products.length;
  if (!totalProducts) {
    return {
      totalScore: 0,
      breakdown: { products: 0, orders: 0, retention: 0, availability: 0 },
      status: "needs_attention",
    };
  }

  const activeProducts = products.filter((p) => p.in_stock).length;
  const inStockRatio = totalProducts > 0 ? activeProducts / totalProducts : 0;
  const orders30d = orders.orders_last_30_days || 0;
  const repeatRate = orders.repeat_customer_rate || 0;

  // 1. Catalog Depth (25 pts)
  const productScore = Math.min(
    totalProducts >= 10 ? 25 : totalProducts >= 5 ? 18 : totalProducts >= 1 ? 10 : 0,
    25
  );

  // 2. Sales Signal (25 pts)
  const orderScore =
    orders30d >= 20 ? 25 :
    orders30d >= 10 ? 20 :
    orders30d >= 5  ? 15 :
    orders30d >= 1  ? 10 : 0;

  // 3. Retention Rate (25 pts)
  const retentionScore = Math.round(Math.min(repeatRate, 1) * 25);

  // 4. In-Stock Availability (25 pts)
  const availabilityScore = Math.round(inStockRatio * 25);

  const totalScore = productScore + orderScore + retentionScore + availabilityScore;

  const status: "healthy" | "moderate" | "needs_attention" =
    totalScore >= 70 ? "healthy" : totalScore >= 40 ? "moderate" : "needs_attention";

  return {
    totalScore,
    breakdown: {
      products: productScore,
      orders: orderScore,
      retention: retentionScore,
      availability: availabilityScore,
    },
    status,
  };
}
