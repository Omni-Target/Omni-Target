import { auth } from "@clerk/nextjs/server";
import { getUserIntegration } from "@/lib/db";

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const integration = await getUserIntegration(userId!);

  // If no Shopify connection
  if (!integration?.shopify_access_token) {
    return Response.json({
      score: 0,
      status: "not_connected",
      issues: [
        "Shopify store not connected"
      ],
      recommendations: [
        "Connect your Shopify store to get started"
      ],
      positives: [],
      breakdown: {
        products: 0,
        orders: 0,
        retention: 0,
        availability: 0
      }
    });
  }

  // Use cached snapshot if available
  const snapshot = integration.store_snapshot;

  if (!snapshot) {
    return Response.json({
      score: 30,
      status: "syncing",
      issues: [
        "Store data is still syncing"
      ],
      recommendations: [
        "Wait a moment and refresh"
      ],
      positives: [],
      breakdown: {
        products: 0,
        orders: 0,
        retention: 0,
        availability: 0
      }
    });
  }

  // Calculate real score from store data
  const products = snapshot.products || [];
  const orders = snapshot.orders || {};

  const activeProducts =
    products.filter((p: any) =>
      p.in_stock
    ).length;
  const totalProducts = products.length;
  const orders30d =
    orders.orders_last_30_days || 0;
  const repeatRate =
    orders.repeat_customer_rate || 0;
  const inStockRatio = totalProducts > 0
    ? activeProducts / totalProducts
    : 0;

  // Score calculation
  const productScore = Math.min(
    totalProducts >= 10 ? 25 :
    totalProducts >= 5 ? 18 :
    totalProducts >= 1 ? 10 : 0,
    25
  );

  const orderScore =
    orders30d >= 20 ? 25 :
    orders30d >= 10 ? 20 :
    orders30d >= 5 ? 15 :
    orders30d >= 1 ? 10 : 0;

  const retentionScore =
    Math.round(repeatRate * 25);

  const availabilityScore =
    Math.round(inStockRatio * 25);

  const totalScore =
    productScore + orderScore +
    retentionScore + availabilityScore;

  // Build issues and recommendations
  const issues: string[] = [];
  const recommendations: string[] = [];

  if (totalProducts < 5) {
    issues.push(
      "Limited product catalog for broad testing"
    );
    recommendations.push(
      "Consider expanding your catalog to give Meta's algorithm more creative variables"
    );
  }

  if (orders30d === 0) {
    issues.push(
      "No recent order data for the algorithm to analyze"
    );
    recommendations.push(
      "Run a small engagement or traffic campaign to generate initial pixel data"
    );
  }

  if (inStockRatio < 0.5) {
    issues.push(
      `A significant portion of your catalog (${totalProducts - activeProducts} items) is currently out of stock`
    );
    recommendations.push(
      "Ensure your core Gateway Products are fully stocked before scaling ad spend"
    );
  }

  if (repeatRate < 0.1) {
    issues.push(
      "Opportunity to increase lifetime value (repeat rate < 10%)"
    );
    recommendations.push(
      "Focus ads on high-retention products or implement a post-purchase email flow"
    );
  }

  // Positive findings
  const positives: string[] = [];
  if (orders30d >= 10) {
    positives.push(
      `Healthy recent sales volume (${orders30d} orders in 30 days)`
    );
  }
  if (totalProducts >= 10) {
    positives.push(
      `Strong catalog size with ${totalProducts} products ready to test`
    );
  }
  if (repeatRate >= 0.2) {
    positives.push(
      `Excellent customer retention (${Math.round(repeatRate * 100)}% repeat rate)`
    );
  }
  if (inStockRatio >= 0.8) {
    positives.push(
      `Great inventory health (${Math.round(inStockRatio * 100)}% in stock)`
    );
  }

  return Response.json({
    score: totalScore,
    status: totalScore >= 70
      ? "healthy"
      : totalScore >= 40
        ? "moderate"
        : "needs_attention",
    issues,
    recommendations,
    positives,
    breakdown: {
      products: productScore,
      orders: orderScore,
      retention: retentionScore,
      availability: availabilityScore
    }
  });
}
