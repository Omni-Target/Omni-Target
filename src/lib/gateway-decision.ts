import type {
  ProductDecisionEvidence,
  StoreAcquisitionMomentum,
  StoreFirstOrderEconomics,
  StoreProductElectionScore,
  StoreProductReturnEvidence,
  StoreVariantStockCoverage,
} from "./store-data";
import type { BuyerOutcomes } from "./buyer-outcomes";

const DAY_MS = 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * DAY_MS;
const HALF_LIFE_DAYS = 90;

export interface DecisionOrder {
  id: number;
  created_at: string;
  total_price?: string | number;
  subtotal_price?: string | number;
  current_subtotal_price?: string | number;
  customer?: { id: number };
  line_items?: Array<{
    product_id: number;
    variant_id?: number;
    quantity?: number;
    price?: string | number;
  }>;
}

export interface DecisionProduct {
  id: number;
  price?: number;
  created_at?: string;
  variants?: Array<{
    id?: number;
    title?: string;
    price?: string | number;
    inventory_quantity: number;
  }>;
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

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseOrderSubtotal(order: DecisionOrder): number | null {
  const raw = order.current_subtotal_price ?? order.subtotal_price ?? order.total_price;
  if (raw === undefined || raw === null || raw === "") return null;
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function inferProductPrice(product: DecisionProduct): number | null {
  if (typeof product.price === "number" && Number.isFinite(product.price) && product.price > 0) {
    return product.price;
  }
  const firstVariantPrice = product.variants?.[0]?.price;
  if (firstVariantPrice !== undefined && firstVariantPrice !== null) {
    const parsed = Number(firstVariantPrice);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Builds each product's historical customer-acquisition role, downstream retention,
 * recency-weighted momentum, Day-1 basket economics, demand-weighted variant stock
 * coverage, and composite 0–100 Cold-Acquisition Election Score.
 *
 * Historical role comes strictly from identified buyers' first and later paid orders.
 * Stock, variant demand curves, cost coverage, and return risk govern test readiness.
 */
export function buildProductDecisions(
  orders: DecisionOrder[],
  products: DecisionProduct[],
  options: {
    asOf: string;
    ingestionComplete: boolean;
    buyerOutcomes?: BuyerOutcomes;
    returnEvidence?: Record<string, StoreProductReturnEvidence>;
    returnEvidenceStatus?: "available" | "missing_scope" | "unavailable" | "error";
  },
): Map<number, ProductDecisionEvidence> {
  const now = new Date(options.asOf).getTime();
  const byCustomer = new Map<number, DecisionOrder[]>();
  const seenOrders = new Set<number>();
  const variantSalesByProduct = new Map<number, Map<number, number>>();

  for (const order of orders) {
    const orderAt = Date.parse(order.created_at);
    if (seenOrders.has(order.id) || !Number.isFinite(orderAt) || orderAt > now) continue;
    seenOrders.add(order.id);

    // Track historical unit volume by variant across all valid paid orders (including guest checkouts)
    // so size-curve / hero-variant demand coverage reflects actual variant popularity.
    for (const item of order.line_items || []) {
      if (!item.product_id || item.product_id <= 0) continue;
      if (item.variant_id && item.variant_id > 0) {
        const qty = Math.max(1, Number(item.quantity) || 1);
        let prodVariants = variantSalesByProduct.get(item.product_id);
        if (!prodVariants) {
          prodVariants = new Map<number, number>();
          variantSalesByProduct.set(item.product_id, prodVariants);
        }
        prodVariants.set(item.variant_id, (prodVariants.get(item.variant_id) || 0) + qty);
      }
    }

    const customerId = order.customer?.id;
    if (!customerId) continue;
    const customerOrders = byCustomer.get(customerId) || [];
    customerOrders.push(order);
    byCustomer.set(customerId, customerOrders);
  }

  const firstCounts = new Map<number, number>();
  const laterCounts = new Map<number, number>();
  const recent60dFirstCounts = new Map<number, number>();
  const priorFirstCounts = new Map<number, number>();
  const decayedFirstScores = new Map<number, number>();
  const firstOrderValueSums = new Map<number, number>();
  const firstOrderValueCounts = new Map<number, number>();
  const multiItemFirstCounts = new Map<number, number>();
  const eligibleCounts = new Map<number, number>();
  const repeatCounts = new Map<number, number>();

  let firstTotal = 0;
  let laterTotal = 0;
  let recent60dFirstTotal = 0;
  let priorFirstTotal = 0;
  let totalEligibleFirstBuyers = 0;
  let totalRepeatedFirstBuyers = 0;
  const allFirstOrderValues: number[] = [];

  for (const customerOrders of byCustomer.values()) {
    customerOrders.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id,
    );
    const first = customerOrders[0];
    firstTotal++;
    const firstAt = new Date(first.created_at).getTime();
    const isRecent60d = Number.isFinite(now) && firstAt > now - SIXTY_DAYS_MS;
    if (isRecent60d) {
      recent60dFirstTotal++;
    } else {
      priorFirstTotal++;
    }

    // Exponential recency weight with 90-day half-life
    const ageDays = Number.isFinite(now) ? Math.max(0, (now - firstAt) / DAY_MS) : 0;
    const decayWeight = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);

    const lineItems = (first.line_items || []).filter((item) => item.product_id > 0);
    const firstProducts = new Set(lineItems.map((item) => item.product_id));
    const totalUnitsInFirstOrder = lineItems.reduce(
      (sum, item) => sum + Math.max(1, Number(item.quantity) || 1),
      0,
    );
    const isMultiItemFirstOrder = firstProducts.size > 1 || totalUnitsInFirstOrder > 1;
    const firstOrderSubtotal = parseOrderSubtotal(first);
    if (firstOrderSubtotal !== null) {
      allFirstOrderValues.push(firstOrderSubtotal);
    }

    for (const productId of firstProducts) {
      firstCounts.set(productId, (firstCounts.get(productId) || 0) + 1);
      decayedFirstScores.set(productId, (decayedFirstScores.get(productId) || 0) + decayWeight);
      if (isRecent60d) {
        recent60dFirstCounts.set(productId, (recent60dFirstCounts.get(productId) || 0) + 1);
      } else {
        priorFirstCounts.set(productId, (priorFirstCounts.get(productId) || 0) + 1);
      }
      if (isMultiItemFirstOrder) {
        multiItemFirstCounts.set(productId, (multiItemFirstCounts.get(productId) || 0) + 1);
      }
      if (firstOrderSubtotal !== null) {
        firstOrderValueSums.set(
          productId,
          (firstOrderValueSums.get(productId) || 0) + firstOrderSubtotal,
        );
        firstOrderValueCounts.set(
          productId,
          (firstOrderValueCounts.get(productId) || 0) + 1,
        );
      }
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
    totalEligibleFirstBuyers++;
    if (boughtAgain) totalRepeatedFirstBuyers++;
    for (const productId of firstProducts) {
      eligibleCounts.set(productId, (eligibleCounts.get(productId) || 0) + 1);
      if (boughtAgain) repeatCounts.set(productId, (repeatCounts.get(productId) || 0) + 1);
    }
  }

  const storeMedianFirstOrderValue = medianOf(allFirstOrderValues);
  const storeBaselineRepeatRate60d =
    totalEligibleFirstBuyers > 0
      ? totalRepeatedFirstBuyers / totalEligibleFirstBuyers
      : 0.2;
  const catalogPriorReach = Math.max(0.05, 1 / Math.max(1, products.length));

  const result = new Map<number, ProductDecisionEvidence>();
  for (const product of products) {
    const firstCount = firstCounts.get(product.id) || 0;
    const laterCount = laterCounts.get(product.id) || 0;
    const firstReach = rate(firstCount, firstTotal);
    const laterReach = rate(laterCount, laterTotal);
    let role: ProductDecisionEvidence["role"] = "Insufficient Data";
    let roleConfidence: ProductDecisionEvidence["role_confidence"] = "insufficient";
    let roleReason = "Too few identified first and later orders to compare this product's role.";

    // Require at least 5% of identified first orders (or 3 orders in a smaller store)
    // so a 3-of-144 (2%) item is not falsely badged as a store Gateway Product.
    const minGatewayReach = 0.05;

    if (!options.ingestionComplete) {
      roleReason = "Order or catalog sync is incomplete; historical role is withheld.";
    } else if (laterTotal === 0) {
      roleReason = "First-order appearances are recorded, but no later orders are available for comparison.";
    } else if (
      firstTotal >= 3 &&
      firstCount >= 3 &&
      firstReach! >= minGatewayReach &&
      firstReach! > laterReach!
    ) {
      role = "Gateway";
      roleConfidence =
        firstTotal >= 10 &&
        laterTotal >= 10 &&
        wilsonInterval(firstCount, firstTotal)[0] > wilsonInterval(laterCount, laterTotal)[1]
          ? "strong"
          : "directional";
      roleReason = `${firstCount} of ${firstTotal} identified first orders contained this product, compared with ${laterCount} of ${laterTotal} later orders.`;
    } else if (
      laterTotal >= 3 &&
      laterCount >= 3 &&
      laterReach! >= minGatewayReach &&
      laterReach! > firstReach!
    ) {
      role = "Consideration";
      roleConfidence =
        firstTotal >= 10 &&
        laterTotal >= 10 &&
        wilsonInterval(laterCount, laterTotal)[0] > wilsonInterval(firstCount, firstTotal)[1]
          ? "strong"
          : "directional";
      roleReason = `${laterCount} of ${laterTotal} identified later orders contained this product, compared with ${firstCount} of ${firstTotal} first orders.`;
    } else if (
      (firstCount >= 3 && (firstReach ?? 0) >= minGatewayReach) ||
      (laterCount >= 3 && (laterReach ?? 0) >= minGatewayReach)
    ) {
      role = "Hybrid";
      roleConfidence = "directional";
      roleReason = `This product appeared in ${firstCount} first orders and ${laterCount} later orders; balanced demand across new and returning customers.`;
    } else if (firstCount > 0 || laterCount > 0) {
      roleReason = `Appeared in ${firstCount} of ${firstTotal} first orders (${Math.round((firstReach ?? 0) * 100)}%) — too small a share of store orders to confirm a gateway role yet.`;
    }

    // ─── 1. Recency-Weighted Acquisition Momentum & Emerging Gateway Detection ───
    const recentFirstCount = options.ingestionComplete
      ? recent60dFirstCounts.get(product.id) || 0
      : 0;
    const priorFirstCount = options.ingestionComplete
      ? priorFirstCounts.get(product.id) || 0
      : 0;
    const recentFirstReach = options.ingestionComplete
      ? rate(recentFirstCount, recent60dFirstTotal)
      : null;
    const priorFirstReach = rate(priorFirstCount, priorFirstTotal);
    const decayedScore = options.ingestionComplete
      ? round2(decayedFirstScores.get(product.id) || 0)
      : 0;

    let velocityTrend: StoreAcquisitionMomentum["velocity_trend"] = "insufficient_data";
    if (options.ingestionComplete && firstCount > 0) {
      if (priorFirstCount === 0 && recentFirstCount >= 2) {
        velocityTrend = "new_signal";
      } else if (
        recentFirstCount >= 2 &&
        recentFirstReach !== null &&
        priorFirstReach !== null &&
        recentFirstReach >= priorFirstReach * 1.25
      ) {
        velocityTrend = "accelerating";
      } else if (
        priorFirstCount >= 3 &&
        ((recent60dFirstTotal >= 3 &&
          (recentFirstCount === 0 ||
            (recentFirstReach !== null &&
              priorFirstReach !== null &&
              recentFirstReach < priorFirstReach * 0.4))) ||
          (recentFirstCount === 0 && decayedScore < firstCount * 0.35))
      ) {
        velocityTrend = "cooling";
      } else {
        velocityTrend = "steady";
      }
    }

    const isEmergingGateway =
      options.ingestionComplete &&
      recentFirstCount >= 2 &&
      recentFirstReach !== null &&
      recentFirstReach > (laterReach ?? 0) &&
      (velocityTrend === "new_signal" ||
        velocityTrend === "accelerating" ||
        (role === "Insufficient Data" && recentFirstReach >= catalogPriorReach * 1.5));

    const acquisitionMomentum: StoreAcquisitionMomentum = {
      recent_60d_first_orders: recentFirstCount,
      recent_60d_total_first_orders: options.ingestionComplete ? recent60dFirstTotal : 0,
      recent_first_order_reach: recentFirstReach,
      decayed_first_order_score: decayedScore,
      velocity_trend: velocityTrend,
      is_emerging_gateway: isEmergingGateway,
    };

    // ─── 2. Day-1 Basket Economics & Entry Price Accessibility ───
    const productPrice = inferProductPrice(product);
    const valSum = firstOrderValueSums.get(product.id) || 0;
    const valCount = firstOrderValueCounts.get(product.id) || 0;
    const avgFirstOrderValue =
      options.ingestionComplete && valCount > 0 ? round2(valSum / valCount) : null;
    const basketMultiplier =
      avgFirstOrderValue !== null && productPrice !== null && productPrice > 0
        ? round2(avgFirstOrderValue / productPrice)
        : null;
    const multiItemRate = options.ingestionComplete
      ? rate(multiItemFirstCounts.get(product.id) || 0, firstCount)
      : null;
    const priceVsMedianFirstOrder =
      productPrice !== null &&
      storeMedianFirstOrderValue !== null &&
      storeMedianFirstOrderValue > 0
        ? round2(productPrice / storeMedianFirstOrderValue)
        : null;

    const firstOrderEconomics: StoreFirstOrderEconomics = {
      avg_first_order_value: avgFirstOrderValue,
      basket_multiplier: basketMultiplier,
      multi_item_first_order_rate: multiItemRate,
      price_vs_median_first_order: priceVsMedianFirstOrder,
    };

    // ─── 3. Demand-Weighted Variant Readiness (Size-Curve Protection) ───
    const variants = product.variants || [];
    const inStock = variants.filter((variant) => variant.inventory_quantity > 0).length;
    const unweightedStockShare = variants.length > 0 ? round2(inStock / variants.length) : 0;

    const prodVariantSales = variantSalesByProduct.get(product.id);
    let demandWeightedStockShare: number | null = null;
    const stockedOutCoreVariants: string[] = [];
    if (variants.length > 1 && prodVariantSales && prodVariantSales.size > 0) {
      let totalTrackedUnits = 0;
      let inStockTrackedUnits = 0;
      for (const variant of variants) {
        if (variant.id == null) continue;
        const soldUnits = prodVariantSales.get(variant.id) || 0;
        totalTrackedUnits += soldUnits;
        if (variant.inventory_quantity > 0) {
          inStockTrackedUnits += soldUnits;
        }
      }
      if (totalTrackedUnits >= 3) {
        demandWeightedStockShare = rate(inStockTrackedUnits, totalTrackedUnits);
        for (const variant of variants) {
          if (variant.id == null || variant.inventory_quantity > 0) continue;
          const soldUnits = prodVariantSales.get(variant.id) || 0;
          if (soldUnits / totalTrackedUnits >= 0.25) {
            stockedOutCoreVariants.push(variant.title || `Variant #${variant.id}`);
          }
        }
      }
    }

    const coreVariantStockout =
      inStock > 0 &&
      demandWeightedStockShare !== null &&
      (demandWeightedStockShare < 0.5 ||
        (stockedOutCoreVariants.length > 0 && demandWeightedStockShare < 0.65));

    const variantStockCoverage: StoreVariantStockCoverage = {
      in_stock_variants: inStock,
      total_variants: variants.length,
      unweighted_stock_share: unweightedStockShare,
      demand_weighted_stock_share: demandWeightedStockShare,
      core_variant_stockout: coreVariantStockout,
      stocked_out_core_variants: stockedOutCoreVariants,
    };

    // ─── 4. Pre-Spend Readiness & Return Guardrails ───
    const returnEvidence = options.returnEvidence?.[String(product.id)];
    const returnEvidenceState =
      options.returnEvidenceStatus === "available"
        ? returnEvidence?.risk === "insufficient_data" || !returnEvidence
          ? "insufficient_data"
          : "available"
        : options.returnEvidenceStatus || "unavailable";
    const highValueEntry = options.buyerOutcomes?.high_value_entry.get(product.id);
    const postEntryBridge = options.buyerOutcomes?.post_entry_bridge?.get(product.id);

    const testReadiness: ProductDecisionEvidence["test_readiness"] =
      inStock === 0
        ? "hold"
        : !options.ingestionComplete ||
            inStock < variants.length ||
            coreVariantStockout ||
            product.unit_cost_coverage !== "complete" ||
            returnEvidence?.risk === "review"
          ? "review"
          : "planning_candidate";

    const readinessReasons =
      inStock === 0
        ? ["No catalog variant currently shows positive stock."]
        : [
            ...(!options.ingestionComplete
              ? ["Shopify order or catalog sync is incomplete; refresh before deciding."]
              : []),
            ...(coreVariantStockout
              ? [
                  `Core variant stockout: high-demand variant${stockedOutCoreVariants.length > 1 ? "s" : ""}${stockedOutCoreVariants.length ? ` (${stockedOutCoreVariants.join(", ")})` : ""} sold out — only ${Math.round((demandWeightedStockShare ?? 0) * 100)}% of historical buyer demand is currently in stock.`,
                ]
              : []),
            inStock < variants.length
              ? `${inStock} of ${variants.length} variants in stock${demandWeightedStockShare !== null && !coreVariantStockout ? ` (${Math.round(demandWeightedStockShare * 100)}% of historical demand covered)` : ""}.`
              : "All catalog variants in stock and ready to promote.",
            product.unit_cost_coverage !== "complete"
              ? "Variant costs are unrecorded in Shopify — verify your profit margins before setting ad budget."
              : "Unit costs recorded — verify target margin covers fulfillment before setting ad budget.",
            ...(returnEvidence?.risk === "review"
              ? [
                  `${returnEvidence.processed_return_units} of ${returnEvidence.eligible_units} eligible units had processed returns; review product quality before testing.`,
                ]
              : []),
          ];

    const eligible = options.ingestionComplete ? eligibleCounts.get(product.id) || 0 : 0;
    const repeated = options.ingestionComplete ? repeatCounts.get(product.id) || 0 : 0;
    const repeatRate60d = rate(repeated, eligible);

    // ─── 5. Proprietary 0–100 Cold-Acquisition Election Score ───
    const electionScore = computeProductElectionScore({
      ingestionComplete: options.ingestionComplete,
      role,
      roleConfidence,
      firstCount,
      firstTotal,
      laterCount,
      laterTotal,
      catalogPriorReach,
      decayedScore,
      eligible60d: eligible,
      repeated60d: repeated,
      storeBaselineRepeatRate60d,
      highValueEntry,
      postEntryBridge,
      acquisitionMomentum,
      firstOrderEconomics,
      variantStockCoverage,
      unitCostCoverage: product.unit_cost_coverage,
      returnRisk: returnEvidence?.risk,
    });

    result.set(product.id, {
      logic_version: 2,
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
        repeat_rate: repeatRate60d,
      },
      ...(highValueEntry ? { high_value_entry: highValueEntry } : {}),
      ...(postEntryBridge ? { post_entry_bridge: postEntryBridge } : {}),
      ...(returnEvidence ? { return_evidence: returnEvidence } : {}),
      return_evidence_state: returnEvidenceState,
      acquisition_momentum: acquisitionMomentum,
      first_order_economics: firstOrderEconomics,
      variant_stock_coverage: variantStockCoverage,
      election_score: electionScore,
      test_readiness: testReadiness,
      readiness_reasons: readinessReasons,
      limitations: [
        "First-purchase metrics reflect accessible store orders and identified buyer accounts.",
        ...(returnEvidenceState === "missing_scope"
          ? ["Shopify return access is not granted for this store."]
          : []),
        ...(returnEvidenceState === "error"
          ? ["Product return data could not be synced; no return risk assessment is shown."]
          : []),
        ...(returnEvidenceState === "unavailable"
          ? ["Product return evidence is unavailable for this snapshot."]
          : []),
        ...(returnEvidence?.risk === "insufficient_data"
          ? ["Too few eligible units to assess product return risk."]
          : []),
      ],
    });
  }
  return result;
}

function computeProductElectionScore(params: {
  ingestionComplete: boolean;
  role: ProductDecisionEvidence["role"];
  roleConfidence: ProductDecisionEvidence["role_confidence"];
  firstCount: number;
  firstTotal: number;
  laterCount: number;
  laterTotal: number;
  catalogPriorReach: number;
  decayedScore: number;
  eligible60d: number;
  repeated60d: number;
  storeBaselineRepeatRate60d: number;
  highValueEntry?: BuyerOutcomes["high_value_entry"] extends Map<number, infer V> ? V : never;
  postEntryBridge?: BuyerOutcomes["post_entry_bridge"] extends Map<number, infer V> ? V : never;
  acquisitionMomentum: StoreAcquisitionMomentum;
  firstOrderEconomics: StoreFirstOrderEconomics;
  variantStockCoverage: StoreVariantStockCoverage;
  unitCostCoverage?: "complete" | "partial" | "missing";
  returnRisk?: StoreProductReturnEvidence["risk"];
}): StoreProductElectionScore {
  if (!params.ingestionComplete) {
    return {
      total: 0,
      breakdown: {
        entry_lift: 0,
        retention_ltv: 0,
        momentum: 0,
        basket_economics: 0,
        operational_readiness: 0,
      },
    };
  }

  // 1. Entry Demand & Gateway Lift (0–35 pts)
  let entryLift = 0;
  if (params.firstCount > 0 && params.firstTotal > 0) {
    const wilsonLower = wilsonInterval(params.firstCount, params.firstTotal)[0];
    const wilsonPts = clamp(wilsonLower / 0.25, 0, 1) * 14;

    const alpha = 4;
    const p0 = params.catalogPriorReach;
    const shrunkFirst = (params.firstCount + alpha * p0) / (params.firstTotal + alpha);
    const shrunkLater =
      params.laterTotal > 0
        ? (params.laterCount + alpha * p0) / (params.laterTotal + alpha)
        : p0;
    const liftRatio =
      shrunkFirst + shrunkLater > 0
        ? (shrunkFirst - shrunkLater) / (shrunkFirst + shrunkLater)
        : 0;
    const liftPts = clamp((liftRatio + 0.4) / 0.9, 0, 1) * 13;

    const volumePts =
      clamp(Math.log1p(Math.max(params.decayedScore, params.firstCount * 0.4)) / Math.log1p(15), 0, 1) *
      6;
    const confidenceBonus =
      params.role === "Gateway" && params.roleConfidence === "strong"
        ? 2
        : params.role === "Gateway"
          ? 1
          : 0;

    entryLift = Math.round(clamp(wilsonPts + liftPts + volumePts + confidenceBonus, 0, 35));
  }

  // 2. Downstream Retention & LTV Expansion (0–25 pts)
  let retentionLtv = 0;
  if (params.eligible60d > 0) {
    const beta = 3;
    const shrunkRepeat60d =
      (params.repeated60d + beta * params.storeBaselineRepeatRate60d) /
      (params.eligible60d + beta);
    const sampleConfidence = 0.5 + 0.5 * clamp(params.eligible60d / 5, 0, 1);
    const repeatPts = clamp(shrunkRepeat60d / 0.5, 0, 1) * 17 * sampleConfidence;
    retentionLtv += repeatPts;
  } else if (params.firstCount > 0) {
    // Neutral prior when first orders are all younger than 60 days
    retentionLtv += 5;
  }

  if (params.highValueEntry && params.highValueEntry.baseline_share > 0) {
    const vipLift =
      params.highValueEntry.high_value_share / params.highValueEntry.baseline_share;
    const vipPts = clamp((vipLift - 0.8) / 1.4, 0, 1) * 8;
    retentionLtv += vipPts;
  } else if (params.postEntryBridge) {
    // When top-decile 50-buyer cohort is not yet reached, reward proven 60d value expansion
    // and cross-catalog exploration from the post-entry transition bridge.
    const expansionMultiple = params.postEntryBridge.value_expansion_60d_multiple ?? 1;
    const expansionPts = clamp((expansionMultiple - 1) / 0.8, 0, 1) * 5;
    const crossCatalogShare =
      params.postEntryBridge.repeat_buyers_from_entry > 0
        ? params.postEntryBridge.cross_catalog_repeat_buyers /
          params.postEntryBridge.repeat_buyers_from_entry
        : 0;
    const crossPts = clamp(crossCatalogShare, 0, 1) * 3;
    retentionLtv += expansionPts + crossPts;
  }
  retentionLtv = Math.round(clamp(retentionLtv, 0, 25));

  // 3. Recent Acquisition Momentum (0–15 pts)
  let momentum = 0;
  const {
    recent_60d_first_orders,
    recent_60d_total_first_orders,
    recent_first_order_reach,
    velocity_trend,
  } = params.acquisitionMomentum;

  if (recent_60d_first_orders > 0) {
    const reachFactor = clamp((recent_first_order_reach ?? 0) / 0.25, 0, 1) * 6;
    const countFactor = clamp(Math.log1p(recent_60d_first_orders) / Math.log1p(10), 0, 1) * 4;
    const trendBonus =
      velocity_trend === "accelerating"
        ? 5
        : velocity_trend === "new_signal"
          ? 4
          : velocity_trend === "steady"
            ? 3
            : 1;
    momentum = Math.round(clamp(reachFactor + countFactor + trendBonus, 0, 15));
  } else if (params.firstCount > 0) {
    if (velocity_trend === "cooling") {
      // Legacy product whose acquisition velocity has stalled
      momentum = 2;
    } else {
      // Historical snapshot without recent 60d store orders
      momentum = Math.round(
        clamp((Math.log1p(params.decayedScore) / Math.log1p(10)) * 9, 3, 10),
      );
    }
  }

  // 4. Day-1 Basket & Price Accessibility (0–15 pts)
  let basketEconomics = 0;
  if (params.firstCount > 0) {
    const {
      basket_multiplier,
      multi_item_first_order_rate,
      price_vs_median_first_order,
    } = params.firstOrderEconomics;

    const multiplierPts =
      basket_multiplier !== null
        ? clamp((basket_multiplier - 0.85) / 0.65, 0, 1) * 7
        : 3.5;
    const attachPts =
      multi_item_first_order_rate !== null
        ? clamp(multi_item_first_order_rate / 0.5, 0, 1) * 4
        : 1.5;
    let pricePts = 2.5;
    if (price_vs_median_first_order !== null) {
      if (price_vs_median_first_order >= 0.35 && price_vs_median_first_order <= 1.15) {
        pricePts = 4;
      } else if (price_vs_median_first_order <= 1.5) {
        pricePts = 2.5;
      } else {
        pricePts = 1;
      }
    }
    basketEconomics = Math.round(clamp(multiplierPts + attachPts + pricePts, 0, 15));
  }

  // 5. Operational & Margin Readiness (0–10 pts)
  let operationalReadiness = 0;
  if (params.variantStockCoverage.in_stock_variants > 0) {
    const effectiveStockShare =
      params.variantStockCoverage.demand_weighted_stock_share ??
      params.variantStockCoverage.unweighted_stock_share;
    const stockPts = params.variantStockCoverage.core_variant_stockout
      ? 0
      : Math.round(clamp(effectiveStockShare, 0, 1) * 5);
    const costPts =
      params.unitCostCoverage === "complete"
        ? 2
        : params.unitCostCoverage === "partial"
          ? 1
          : 0;
    const returnPts =
      params.returnRisk === "review"
        ? 0
        : params.returnRisk === "observed"
          ? 3
          : 2;
    operationalReadiness = clamp(stockPts + costPts + returnPts, 0, 10);
  }

  const total = clamp(
    entryLift + retentionLtv + momentum + basketEconomics + operationalReadiness,
    0,
    100,
  );

  return {
    total,
    breakdown: {
      entry_lift: entryLift,
      retention_ltv: retentionLtv,
      momentum,
      basket_economics: basketEconomics,
      operational_readiness: operationalReadiness,
    },
  };
}

/**
 * Compares products for cold-acquisition testing without altering their historical role.
 *
 * Hierarchy:
 * 1. Out-of-stock / held products always rank last (Tier 2).
 * 2. Products with severe operational risk (elevated return risk, broken core-variant size curve,
 *    or incomplete sync) rank below clean marketable candidates (Tier 1 vs Tier 0).
 *    Note: A missing Shopify unit_cost field or a minor fringe variant out of stock does NOT
 *    artificially demote a strong Gateway below a weak candidate; instead it is reflected in
 *    the 10-point operational_readiness component of `election_score`.
 * 3. Gateway products (and Emerging Gateways) rank ahead of non-Gateway products.
 * 4. Candidates are ranked by their multi-factor `election_score.total` (combining Bayesian
 *    first-order lift, 60d repeat retention + 180d VIP lift, 60d recency momentum, Day-1 basket
 *    multiplier, and demand-weighted variant readiness), breaking ties by readiness, confidence,
 *    60-day repeat rate, first-order count, and revenue.
 */
export function compareProductsForTest(
  a: {
    in_stock?: boolean;
    gateway_classification?: string;
    product_decision?: ProductDecisionEvidence;
    revenue?: number;
  },
  b: {
    in_stock?: boolean;
    gateway_classification?: string;
    product_decision?: ProductDecisionEvidence;
    revenue?: number;
  },
): number {
  const operationalTier = (product: typeof a) => {
    const decision = product.product_decision;
    if (product.in_stock === false || decision?.test_readiness === "hold") return 2;
    if (!decision) return 0;
    const hasReturnRisk = decision.return_evidence?.risk === "review";
    const hasCoreStockout = decision.variant_stock_coverage?.core_variant_stockout === true;
    const hasSevereUnweightedGap =
      decision.variant_stock_coverage !== undefined &&
      decision.variant_stock_coverage.demand_weighted_stock_share === null &&
      decision.variant_stock_coverage.total_variants > 1 &&
      decision.variant_stock_coverage.unweighted_stock_share < 0.5;
    if (hasReturnRisk || hasCoreStockout || hasSevereUnweightedGap) return 1;
    // If no gateway signal exists and readiness is review, keep below clean planning_candidates
    const role = decision.role || product.gateway_classification;
    if (role !== "Gateway" && decision.test_readiness === "review") return 1;
    return 0;
  };

  const tierDiff = operationalTier(a) - operationalTier(b);
  if (tierDiff !== 0) return tierDiff;

  const roleRank = (product: typeof a) => {
    const role = product.product_decision?.role || product.gateway_classification;
    if (role === "Gateway") return 0;
    if (product.product_decision?.acquisition_momentum?.is_emerging_gateway) return 1;
    if (role === "Hybrid") return 2;
    return 3;
  };

  const roleDiff = roleRank(a) - roleRank(b);
  if (roleDiff !== 0) return roleDiff;

  // Multi-factor Cold-Acquisition Election Score comparison
  const scoreA = a.product_decision?.election_score?.total;
  const scoreB = b.product_decision?.election_score?.total;
  if (scoreA !== undefined && scoreB !== undefined && scoreA !== scoreB) {
    return scoreB - scoreA;
  }

  // Deterministic tie-breakers
  const readinessRank = (product: typeof a) =>
    !product.in_stock || product.product_decision?.test_readiness === "hold"
      ? 2
      : product.product_decision?.test_readiness === "review"
        ? 1
        : 0;
  const readinessDifference = readinessRank(a) - readinessRank(b);
  if (readinessDifference !== 0) return readinessDifference;

  const confidenceRank = (product: typeof a) =>
    product.product_decision?.role_confidence === "strong" ? 0 : 1;
  const confidenceDifference = confidenceRank(a) - confidenceRank(b);
  if (confidenceDifference !== 0) return confidenceDifference;

  const followUpDifference =
    (b.product_decision?.follow_up_60d.repeat_rate ?? -1) -
    (a.product_decision?.follow_up_60d.repeat_rate ?? -1);
  if (followUpDifference !== 0) return followUpDifference;

  const firstOrderDifference =
    (b.product_decision?.first_order_count ?? 0) -
    (a.product_decision?.first_order_count ?? 0);
  if (firstOrderDifference !== 0) return firstOrderDifference;

  return (b.revenue ?? 0) - (a.revenue ?? 0);
}

/**
 * Selects the top gateway test candidate. Prioritizes ready/marketable Gateways by their
 * composite Cold-Acquisition Election Score, with graceful fallback to emerging gateways
 * when a store is still accumulating lifetime history. Products on hold (out of stock)
 * are never selected as active test candidates.
 */
export function selectGatewayTestCandidate<
  T extends {
    gateway_classification?: string;
    product_decision?: ProductDecisionEvidence;
    in_stock?: boolean;
    revenue?: number;
  },
>(products: T[]): T | null {
  const candidates = products
    .filter((product) => {
      const role = product.product_decision?.role || product.gateway_classification;
      const isGatewayOrEmerging =
        role === "Gateway" ||
        product.product_decision?.acquisition_momentum?.is_emerging_gateway === true;
      const notOnHold =
        product.in_stock !== false && product.product_decision?.test_readiness !== "hold";
      return isGatewayOrEmerging && notOnHold;
    })
    .sort(compareProductsForTest);

  return candidates[0] || null;
}
