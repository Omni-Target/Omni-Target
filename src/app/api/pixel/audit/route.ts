import { auth } from "@clerk/nextjs/server";
import { getUserIntegration } from "@/lib/db";

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const integration = await getUserIntegration(userId!);

  if (!integration?.shopify_access_token) {
    return Response.json({
      score: 0,
      status: "not_connected",
      issues: ["Shopify store not connected"],
      recommendations: ["Connect your Shopify store to get started"],
      positives: [],
      breakdown: { products: 0, orders: 0, retention: 0, availability: 0 },
    });
  }

  const snapshot = integration.store_snapshot;

  if (!snapshot) {
    return Response.json({
      score: 30,
      status: "syncing",
      issues: ["Store data is still syncing"],
      recommendations: ["Wait a moment and refresh"],
      positives: [],
      breakdown: { products: 0, orders: 0, retention: 0, availability: 0 },
    });
  }

  const products = snapshot.products || [];
  const orders = snapshot.orders || {};

  // ── Core metrics ─────────────────────────────────────────────────────────
  const inStockProducts = products.filter((p) => p.in_stock);
  const outOfStockProducts = products.filter((p) => !p.in_stock);
  const totalProducts = products.length;
  const activeProducts = inStockProducts.length;
  const orders30d: number = orders.orders_last_30_days || 0;
  const repeatRate: number = orders.repeat_customer_rate || 0;
  const inStockRatio = totalProducts > 0 ? activeProducts / totalProducts : 0;

  // ── Score calculation ─────────────────────────────────────────────────────
  const productScore = Math.min(
    totalProducts >= 10 ? 25 : totalProducts >= 5 ? 18 : totalProducts >= 1 ? 10 : 0,
    25
  );
  const orderScore =
    orders30d >= 20 ? 25 :
    orders30d >= 10 ? 20 :
    orders30d >= 5  ? 15 :
    orders30d >= 1  ? 10 : 0;
  const retentionScore = Math.round(repeatRate * 25);
  const availabilityScore = Math.round(inStockRatio * 25);
  const totalScore = productScore + orderScore + retentionScore + availabilityScore;



  // ── Identify the best product to lead with ────────────────────────────────
  // Priority 1: in-stock Gateway product with highest velocity
  // Priority 2: in-stock product with most units sold
  const gatewayInStock = [...inStockProducts]
    .filter((p) => p.gateway_classification === "Gateway")
    .sort((a, b) =>
      (b.order_velocity || b.units_sold || 0) - (a.order_velocity || a.units_sold || 0)
    );

  const topByUnitsSold = [...inStockProducts].sort(
    (a, b) => (b.units_sold || 0) - (a.units_sold || 0)
  );

  const bestProduct = gatewayInStock[0] || topByUnitsSold[0] || null;
  const isGatewayPick = gatewayInStock.length > 0;

  // ── Gateway stock risk check ──────────────────────────────────────────────
  const allGatewayProducts = products.filter((p) => p.gateway_classification === "Gateway");
  const gatewayOutOfStock = allGatewayProducts.filter((p) => !p.in_stock);
  const hasAnyGatewayInStock = allGatewayProducts.some((p) => p.in_stock);

  // ── POSITIVES — "Start Here" ──────────────────────────────────────────────
  const positives: string[] = [];

  if (bestProduct) {
    if (isGatewayPick) {
      const velocity = bestProduct.order_velocity;
      const soldCount = bestProduct.units_sold || 0;
      let reason = "converts cold traffic well";
      if (velocity && velocity > 0) {
        reason = `sells regularly and converts cold traffic well`;
      } else if (soldCount > 0) {
        reason = `has ${soldCount} sales and is classified as a cold-traffic converter`;
      }
      positives.push(
        `Start with ${bestProduct.name}. It's your strongest gateway product — ${reason}. This is your lowest-risk entry point for paid ads.`
      );
    } else if ((bestProduct.units_sold || 0) > 0) {
      positives.push(
        `Start with ${bestProduct.name} — your top-selling in-stock product with ${bestProduct.units_sold} units sold. Lead with what's already working before testing anything new.`
      );
    } else {
      positives.push(
        `Start with ${bestProduct.name}. It has no sales history yet, so frame the campaign as a first-look or early-access moment — not a proven bestseller.`
      );
    }
  }

  if (orders30d >= 10) {
    positives.push(
      `${orders30d} orders in the last 30 days gives Meta's algorithm real purchase signal. You're past the hardest part of the learning phase.`
    );
  }

  if (repeatRate >= 0.2) {
    positives.push(
      `${Math.round(repeatRate * 100)}% of your customers come back for more. You have enough repeat buyers to build a high-quality lookalike audience from your customer list.`
    );
  }

  // ── ISSUES — "What to Know" ───────────────────────────────────────────────
  const issues: string[] = [];

  // Gateway stock risk — highest priority flag
  if (allGatewayProducts.length > 0 && !hasAnyGatewayInStock) {
    const names = gatewayOutOfStock.map((p) => p.name).join(", ");
    issues.push(
      `Your gateway product${gatewayOutOfStock.length > 1 ? "s are" : " is"} out of stock (${names}). Running ads right now means paying to send traffic to unavailable products. Restock before scaling.`
    );
  }

  if (orders30d === 0) {
    issues.push(
      "No recent purchases means Meta has zero conversion signal to optimise toward. Run your first campaign with a Traffic or Engagement objective — not Purchase — until you've generated at least 10–20 orders."
    );
  } else if (orders30d < 10) {
    issues.push(
      `${orders30d} order${orders30d > 1 ? "s" : ""} in the last 30 days is below Meta's optimisation threshold. Meta needs roughly 50 conversions per week to exit the learning phase. Start with Add to Cart as your objective, then switch to Purchase once volume picks up.`
    );
  }

  if (inStockRatio < 0.5 && outOfStockProducts.length > 0) {
    issues.push(
      `${outOfStockProducts.length} of your ${totalProducts} products are out of stock. Keep your budget on the ${activeProducts} available product${activeProducts !== 1 ? "s" : ""} — spending across unavailable inventory burns budget with no return.`
    );
  }

  if (repeatRate < 0.1 && orders30d > 0) {
    issues.push(
      "Under 10% of your customers make a second purchase. Your ads should be focused on new customer acquisition — not retargeting. Add a post-purchase email sequence to drive repeat revenue without extra ad spend."
    );
  }

  // ── RECOMMENDATIONS — "Your Ad Strategy" ─────────────────────────────────
  const recommendations: string[] = [];

  // Sequencing recommendation
  if (bestProduct && inStockProducts.length > 1) {
    const secondProduct = isGatewayPick
      ? topByUnitsSold.find((p) => p.name !== bestProduct.name)
      : topByUnitsSold[1];
    if (secondProduct) {
      recommendations.push(
        `Don't run everything at once. Start with ${bestProduct.name}, let it run for at least 7 days, then introduce ${secondProduct.name} once you have data. Running both simultaneously splits Meta's learning across two campaigns.`
      );
    }
  } else if (bestProduct) {
    recommendations.push(
      `Keep your full budget on ${bestProduct.name} rather than splitting across multiple creatives. Consolidation wins early — diversify only once you have a clear winner.`
    );
  }

  // Audience strategy based on repeat rate
  if (repeatRate < 0.15) {
    recommendations.push(
      "With a low repeat rate, your best audience is new people — not past visitors. Use Meta's Advantage+ audience or broad interest targeting. Don't narrow with detailed interests until you have enough purchase data for lookalikes."
    );
  } else if (repeatRate >= 0.2) {
    recommendations.push(
      "Your repeat rate is strong enough to build a lookalike. Upload your customer email list to Meta and create a 2–3% lookalike audience for your next campaign — it'll outperform interest targeting at this stage."
    );
  }

  return Response.json({
    score: totalScore,
    status: totalScore >= 70 ? "healthy" : totalScore >= 40 ? "moderate" : "needs_attention",
    issues,
    recommendations,
    positives,
    breakdown: {
      products: productScore,
      orders: orderScore,
      retention: retentionScore,
      availability: availabilityScore,
    },
  });
}
