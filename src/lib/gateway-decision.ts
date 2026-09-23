import type { ProductDecisionEvidence } from "./store-data";

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

interface DecisionOrder {
  id: number;
  created_at: string;
  customer?: { id: number };
  line_items?: Array<{ product_id: number }>;
}

interface DecisionProduct {
  id: number;
  variants?: Array<{ inventory_quantity: number }>;
  unit_cost_coverage?: "complete" | "partial" | "missing";
}

function wilsonInterval(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const radius =
    (z / denominator) *
    Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

/**
 * A product's role comes only from its relative appearance in identified buyers'
 * first and later accessible paid orders. Stock and cost coverage affect the
 * separate planning judgment, never the historical role.
 */
export function buildProductDecisions(
  orders: DecisionOrder[],
  products: DecisionProduct[],
  options: { asOf: string; ingestionComplete: boolean },
): Map<number, ProductDecisionEvidence> {
  const now = new Date(options.asOf).getTime();
  const byCustomer = new Map<number, DecisionOrder[]>();
  for (const order of orders) {
    const customerId = order.customer?.id;
    if (!customerId || !Number.isFinite(new Date(order.created_at).getTime())) continue;
    const customerOrders = byCustomer.get(customerId) || [];
    customerOrders.push(order);
    byCustomer.set(customerId, customerOrders);
  }

  const firstCounts = new Map<number, number>();
  const laterCounts = new Map<number, number>();
  const eligibleCounts = new Map<number, number>();
  const repeatCounts = new Map<number, number>();
  let firstTotal = 0;
  let laterTotal = 0;

  for (const customerOrders of byCustomer.values()) {
    customerOrders.sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id,
    );
    const first = customerOrders[0];
    firstTotal++;
    const firstAt = new Date(first.created_at).getTime();
    const firstProducts = new Set(
      (first.line_items || []).map((item) => item.product_id).filter((id) => id > 0),
    );
    for (const productId of firstProducts) {
      firstCounts.set(productId, (firstCounts.get(productId) || 0) + 1);
    }

    for (const later of customerOrders.slice(1)) {
      laterTotal++;
      for (const productId of new Set(
        (later.line_items || []).map((item) => item.product_id).filter((id) => id > 0),
      )) {
        laterCounts.set(productId, (laterCounts.get(productId) || 0) + 1);
      }
    }

    // Recent first orders cannot yet supply a complete 60-day observation.
    if (!Number.isFinite(now) || firstAt > now - SIXTY_DAYS_MS) continue;
    const boughtAgain = customerOrders.slice(1).some((order) => {
      const orderAt = new Date(order.created_at).getTime();
      return orderAt > firstAt && orderAt <= firstAt + SIXTY_DAYS_MS;
    });
    for (const productId of firstProducts) {
      eligibleCounts.set(productId, (eligibleCounts.get(productId) || 0) + 1);
      if (boughtAgain) repeatCounts.set(productId, (repeatCounts.get(productId) || 0) + 1);
    }
  }

  const result = new Map<number, ProductDecisionEvidence>();
  for (const product of products) {
    const firstCount = firstCounts.get(product.id) || 0;
    const laterCount = laterCounts.get(product.id) || 0;
    const firstReach = rate(firstCount, firstTotal);
    const laterReach = rate(laterCount, laterTotal);
    let role: ProductDecisionEvidence["role"] = "Insufficient Data";
    let roleConfidence: ProductDecisionEvidence["role_confidence"] = "insufficient";
    let roleReason = "Too few identified first and later orders to compare this product's role.";

    if (!options.ingestionComplete) {
      roleReason = "Order or catalog sync is incomplete; historical role is withheld.";
    } else if (laterTotal === 0) {
      roleReason = "First-order appearances are recorded, but no later orders are available for comparison.";
    } else if (firstTotal >= 3 && firstCount >= 3 && firstReach! > laterReach!) {
      role = "Gateway";
      roleConfidence =
        firstTotal >= 10 && laterTotal >= 10 &&
        wilsonInterval(firstCount, firstTotal)[0] > wilsonInterval(laterCount, laterTotal)[1]
          ? "strong"
          : "directional";
      roleReason = `${firstCount} of ${firstTotal} identified first orders contained this product, compared with ${laterCount} of ${laterTotal} later orders.`;
    } else if (laterTotal >= 3 && laterCount >= 3 && laterReach! > firstReach!) {
      role = "Consideration";
      roleConfidence =
        firstTotal >= 10 && laterTotal >= 10 &&
        wilsonInterval(laterCount, laterTotal)[0] > wilsonInterval(firstCount, firstTotal)[1]
          ? "strong"
          : "directional";
      roleReason = `${laterCount} of ${laterTotal} identified later orders contained this product, compared with ${firstCount} of ${firstTotal} first orders.`;
    } else if (firstCount >= 3 || laterCount >= 3) {
      role = "Hybrid";
      roleConfidence = "directional";
      roleReason = `This product appeared in ${firstCount} first orders and ${laterCount} later orders; neither pattern is strong enough to assign a distinct role.`;
    }

    const variants = product.variants || [];
    const inStock = variants.filter((variant) => variant.inventory_quantity > 0).length;
    const testReadiness: ProductDecisionEvidence["test_readiness"] =
      inStock === 0 ? "hold" : !options.ingestionComplete || inStock < variants.length || product.unit_cost_coverage !== "complete"
        ? "review"
        : "planning_candidate";
    const readinessReasons =
      inStock === 0
        ? ["No catalog variant currently shows positive stock."]
        : [
            ...(!options.ingestionComplete ? ["Shopify order or catalog sync is incomplete; refresh before deciding."] : []),
            inStock < variants.length
              ? `${inStock} of ${variants.length} variants in stock.`
              : "All catalog variants in stock and ready to promote.",
            product.unit_cost_coverage !== "complete"
              ? "Recorded variant costs are incomplete; verify margins before setting target CPA."
              : "Unit costs recorded — verify target CPA covers fulfillment and processing costs.",
          ];
    const eligible = options.ingestionComplete ? eligibleCounts.get(product.id) || 0 : 0;
    const repeated = options.ingestionComplete ? repeatCounts.get(product.id) || 0 : 0;
    result.set(product.id, {
      logic_version: 1,
      source: "shopify_accessible_paid_orders_and_catalog",
      as_of: options.asOf,
      role,
      role_confidence: roleConfidence,
      first_order_count: firstCount,
      identified_first_orders: firstTotal,
      first_order_reach: firstReach,
      later_order_count: laterCount,
      identified_later_orders: laterTotal,
      later_order_reach: laterReach,
      role_reason: roleReason,
      follow_up_60d: {
        eligible_first_order_buyers: eligible,
        buyers_with_another_order: repeated,
        repeat_rate: rate(repeated, eligible),
      },
      test_readiness: testReadiness,
      readiness_reasons: readinessReasons,
      limitations: [
        "First-purchase metrics reflect accessible store orders and identified buyer accounts.",
      ],
    });
  }
  return result;
}

/** Compare candidates for planning without changing their observed product role. */
export function compareProductsForTest(
  a: { in_stock?: boolean; gateway_classification?: string; product_decision?: ProductDecisionEvidence; revenue?: number },
  b: { in_stock?: boolean; gateway_classification?: string; product_decision?: ProductDecisionEvidence; revenue?: number },
): number {
  const readinessRank = (product: typeof a) =>
    !product.in_stock || product.product_decision?.test_readiness === "hold" ? 2
      : product.product_decision?.test_readiness === "review" ? 1 : 0;
  const readinessDifference = readinessRank(a) - readinessRank(b);
  if (readinessDifference) return readinessDifference;
  const gatewayRank = (product: typeof a) =>
    product.gateway_classification === "Gateway"
      ? product.product_decision?.role_confidence === "strong" ? 0 : 1
      : 2;
  const gatewayDifference = gatewayRank(a) - gatewayRank(b);
  if (gatewayDifference) return gatewayDifference;
  const firstOrderDifference =
    (b.product_decision?.first_order_count ?? 0) -
    (a.product_decision?.first_order_count ?? 0);
  return firstOrderDifference || (b.revenue ?? 0) - (a.revenue ?? 0);
}
