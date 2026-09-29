import { auth } from "@clerk/nextjs/server";
import { getUserIntegration } from "@/lib/db";
import { calculateAdReadinessScore } from "@/lib/ad-readiness-score";
import { compareProductsForTest, selectGatewayTestCandidate } from "@/lib/gateway-decision";

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

  let snapshot = integration.store_snapshot;

  if (!snapshot) {
    try {
      const { getValidShopifyToken } = await import("@/lib/shopify-token");
      const tokenResult = await getValidShopifyToken(userId);
      if (tokenResult.status === "ok") {
        const { fetchShopifyStoreData } = await import("@/lib/connectors/shopify");
        const { updateUserIntegration } = await import("@/lib/db");
        snapshot = await fetchShopifyStoreData(
          tokenResult.shopUrl,
          tokenResult.accessToken,
          userId
        );
        await updateUserIntegration(userId, {
          store_snapshot: snapshot,
          store_snapshot_at: new Date().toISOString(),
        });
      }
    } catch (fetchErr) {
      console.warn("Audit on-the-fly snapshot fetch warning:", fetchErr);
    }
  }

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

  // ── Score calculation (Unified Single Source of Truth) ─────────────────────
  const { totalScore, breakdown, status } = calculateAdReadinessScore(products, orders);



  // ── Identify the best product to lead with ────────────────────────────────
  // Rank current planning candidates; stock does not redefine their historical role.
  const rankedInStock = [...inStockProducts].sort(compareProductsForTest);

  const topByUnitsSold = [...inStockProducts].sort(
    (a, b) => (b.units_sold || 0) - (a.units_sold || 0)
  );

  const bestProduct = selectGatewayTestCandidate(inStockProducts);
  const researchCandidate = rankedInStock[0] || null;

  // ── Gateway stock risk check ──────────────────────────────────────────────
  const allGatewayProducts = products.filter((p) => p.gateway_classification === "Gateway");
  const gatewayOutOfStock = allGatewayProducts.filter((p) => !p.in_stock);
  const hasAnyGatewayInStock = allGatewayProducts.some((p) => p.in_stock);

  // ── POSITIVES — "Start Here" ──────────────────────────────────────────────
  const positives: string[] = [];

  if (bestProduct) {
      const decision = bestProduct.product_decision;
      let conversionText = "Its accessible order history shows a first-order gateway signal.";
      if (decision?.first_order_count && decision.identified_first_orders) {
        const pct = Math.round((decision.first_order_count / decision.identified_first_orders) * 100);
        conversionText = `${decision.first_order_count} of ${decision.identified_first_orders} identified first orders (${pct}%) contained this product.`;
      }

      const totalVariants = bestProduct.total_variant_count || 0;
      const inStockVariants = bestProduct.in_stock_variant_count || 0;
      const stockText =
        totalVariants === 0
          ? "In stock and ready to promote."
          : inStockVariants === totalVariants
            ? "All variants are in stock and ready to promote."
            : inStockVariants > 0
              ? `${inStockVariants} of ${totalVariants} variants in stock.`
              : "Currently low or out of stock — replenish inventory before spending ad dollars.";

      const marginText =
        bestProduct.unit_cost_coverage === "complete"
          ? "Unit costs are recorded — verify your target margin covers fulfillment before launching."
          : "Make sure your unit profit margin leaves healthy room for ad spend before launching.";

      positives.push(
        `Test candidate: "${bestProduct.name}". ${conversionText} ${stockText} ${marginText}`
      );
  } else if (researchCandidate) {
    positives.push(`No ready gateway has enough historical evidence for a top cold-acquisition recommendation. "${researchCandidate.name}" can be considered as an initial test hypothesis; review its stock, costs, and buyer evidence before spending.`);
  }

  if (orders30d >= 10) {
    positives.push(
      `${orders30d} orders recorded in Shopify in the last 30 days. You have solid sales momentum to give Meta's algorithm clear purchase signals.`
    );
  }

  if (repeatRate >= 0.2) {
    positives.push(
      `${Math.round(repeatRate * 100)}% of your customers are repeat buyers. That loyalty is a superpower — it proves people genuinely love your product once they try it.`
    );
  }

  // ── ISSUES — "What to Know" ───────────────────────────────────────────────
  const issues: string[] = [];

  // Gateway stock risk — highest priority flag
  if (allGatewayProducts.length > 0 && !hasAnyGatewayInStock) {
    const names = gatewayOutOfStock.map((p) => p.name).join(", ");
    issues.push(
      `Your best gateway product${gatewayOutOfStock.length > 1 ? "s are" : " is"} currently out of stock (${names}). Never spend ad dollars sending traffic to sold-out items — restock before ramping up.`
    );
  }

  if (orders30d === 0) {
    issues.push(
      "No store orders in the last 30 days yet. We'll set your first campaign to find interested shoppers who browse and add to cart, building up buying interest without burning money on empty clicks."
    );
  } else if (orders30d < 10) {
    issues.push(
      `With ${orders30d} order${orders30d > 1 ? "s" : ""} recently, keep your ad budget focused on a single hero product so Meta gets enough clear sales data quickly.`
    );
  }

  if (inStockRatio < 0.5 && outOfStockProducts.length > 0) {
    issues.push(
      `${outOfStockProducts.length} of your ${totalProducts} products are out of stock. Keep your ad spend strictly on the ${activeProducts} available item${activeProducts !== 1 ? "s" : ""} to avoid wasted clicks.`
    );
  }

  if (repeatRate < 0.1 && orders30d > 0) {
    issues.push(
      "Most of your revenue currently comes from first-time shoppers. Focus your ads on attracting new customers, and use automated post-purchase emails to drive repeat sales for free."
    );
  }

  // ── RECOMMENDATIONS — "Your Ad Strategy" ─────────────────────────────────
  const recommendations: string[] = [];

  // Sequencing recommendation
  if (bestProduct && inStockProducts.length > 1) {
    const secondProduct = topByUnitsSold.find((p) => p.name !== bestProduct.name);
    if (secondProduct) {
      recommendations.push(
        `Test "${bestProduct.name}" as the first cold-acquisition candidate before comparing it with "${secondProduct.name}". Keep the first test focused on one product so its results are interpretable.`
      );
    }
  } else if (bestProduct) {
    recommendations.push(
      `Start with a focused test on "${bestProduct.name}". Set a controlled daily budget and measure the results before increasing spend.`
    );
  }

  // Audience strategy based on repeat rate
  if (repeatRate < 0.15) {
    recommendations.push(
      "Most of your sales will come from new customers. Keep your audience open and broad, and let compelling ad visuals do the selling to bring in buyers."
    );
  } else if (repeatRate >= 0.2) {
    recommendations.push(
      "Your repeat customer rate is strong. We'll use your buyer history to find similar high-value customers, while reserving a small slice of budget to welcome past customers back for new purchases."
    );
  }

  return Response.json({
    score: totalScore,
    status,
    issues,
    recommendations,
    positives,
    breakdown,
  });
}
