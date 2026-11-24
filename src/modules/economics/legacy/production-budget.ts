/**
 * FROZEN REFERENCE: the production budget engine as it runs on `main` at
 * ad56bfc (Phase 4, task 1; architecture/phase-4-economics.md).
 *
 * It reproduces, line for line, the formulas merchants receive today, so the
 * before-and-after comparison runs the old engine on the same inputs as the
 * new one instead of describing it. Each function names the lines it copies.
 * Do not fix anything here: its faults are what the comparison measures.
 *
 * The app never imports this file (src/platform/boundaries.test.ts).
 */
export const LEGACY_PRODUCTION_SOURCE = "main@ad56bfc" as const;
export const LEGACY_TEST_DURATION_DAYS = 14;

export type LegacyTier = "Starter" | "Growth" | "Scale";
export type LegacyGoal = "Drive Website Sales" | "Grow Brand Awareness" | "Promote a New Collection" | "Retarget Past Visitors";

/** insights-engine.ts:1355-1361 (and the low-data copy at :1088-1093). */
export const LEGACY_GOAL_MULTIPLIERS: Record<LegacyGoal, number> = {
  "Drive Website Sales": 1.0,
  "Grow Brand Awareness": 0.6,
  "Promote a New Collection": 1.2,
  "Retarget Past Visitors": 0.4,
};

export interface LegacyStrategy { label: "Dip Your Toe" | "Sweet Spot" | "Full Send"; daily: number }

export interface LegacyEngineInput {
  /**
   * storeData.orders.revenue_last_30_days in the store currency: the sum of
   * total_price (tax and shipping included) over the last 30 days of orders
   * fetched with financial_status=paid (connectors/shopify.ts:314, :389-391).
   */
  revenueLast30Days: number;
  /** Store-currency units per USD (exchange-rate snapshot). */
  exchangeRate: number;
  /** storeData.orders.order_count. */
  orderCount: number;
  /** The selected product's first-variant price (shopify.ts:727), when generating for a product. */
  productPrice?: number | null;
  /** storeData.orders.average_order_value. */
  storeAverageOrderValue?: number;
  /** Median of the catalog's first-variant prices. */
  medianCatalogPrice?: number;
}

export interface LegacyEngineResult {
  path: "low_data_starter" | "revenue_tier";
  tier: LegacyTier;
  /** Total 14-day test budget in USD from the revenue tier (null on the low-data path). */
  totalTestBudgetUSD: number | null;
  baselineDailyUSD: number;
  effectivePrice: number;
  priceGuardrailUSD: number;
  finalDailyUSD: number;
  /** The "Sweet Spot" daily figure in the store currency, rounded to a whole unit. */
  recommendedDaily: number;
  selectedRule: "low_data_fixed" | "price_guardrail" | "revenue_tier_baseline";
  premiumPriceWarning: boolean;
  highBudgetWarning: boolean;
  /** False when the engine strips budget warnings (fewer than 20 orders, :1655-1667). */
  warningsShown: boolean;
  strategies: LegacyStrategy[];
  /** international_recommended_daily: always set, so the plain-text export always adds overseas spend. */
  internationalRecommendedDaily: number;
  durationDays: number;
}

/** budget-evidence.ts:18-23. */
export function legacyEstimateDailyTestBudget(baselineDaily: number, productPrice: number): number {
  const guardrail = productPrice * 0.5;
  return guardrail > baselineDaily * 3 ? baselineDaily : Math.max(baselineDaily, guardrail);
}

/** market-geography.ts:479-490: the $18 / $25 / $40 overseas strategies, on the exchange-rate path. */
export function legacyInternationalStrategies(exchangeRate: number): LegacyStrategy[] {
  return [
    { label: "Dip Your Toe", daily: Math.round(18 * exchangeRate) },
    { label: "Sweet Spot", daily: Math.round(25 * exchangeRate) },
    { label: "Full Send", daily: Math.round(40 * exchangeRate) },
  ];
}

/** The production engine's budget block (insights-engine.ts:1015-1125 and :1226-1439). */
export function legacyEngineBudget(input: LegacyEngineInput): LegacyEngineResult {
  const fx = input.exchangeRate;
  const aov = input.storeAverageOrderValue ?? 0;
  const median = input.medianCatalogPrice ?? 0;
  const hasProduct = Boolean(input.productPrice && input.productPrice > 0);

  // :1015-1125: fewer than 20 orders and no selected product → a fixed 15 USD/day plan.
  if (input.orderCount < 20 && !hasProduct) {
    const effectiveLowDataAov = aov > 0 ? aov : median > 0 ? median : 25 * fx;
    return {
      path: "low_data_starter",
      tier: "Starter",
      totalTestBudgetUSD: null,
      baselineDailyUSD: 15,
      effectivePrice: effectiveLowDataAov,
      priceGuardrailUSD: (effectiveLowDataAov / fx) * 0.5,
      finalDailyUSD: 15,
      recommendedDaily: Math.round(15 * fx),
      selectedRule: "low_data_fixed",
      premiumPriceWarning: false,
      highBudgetWarning: false,
      warningsShown: false,
      strategies: [
        { label: "Dip Your Toe", daily: Math.round(15 * fx * 0.7) },
        { label: "Sweet Spot", daily: Math.round(15 * fx * 1.0) },
        { label: "Full Send", daily: Math.round(15 * fx * 1.4) },
      ],
      internationalRecommendedDaily: Math.round(18 * fx),
      durationDays: LEGACY_TEST_DURATION_DAYS,
    };
  }

  // :1228-1232: revenue_avg_3_months is never populated, so this is revenue_last_30_days.
  const avgMonthlyRevenue = input.revenueLast30Days || 0;
  const avgMonthlyRevenueUSD = avgMonthlyRevenue / fx;

  // :1237-1249.
  let totalTestBudgetUSD = 150;
  let tier: LegacyTier = "Starter";
  if (avgMonthlyRevenueUSD < 2000) {
    totalTestBudgetUSD = 150;
    tier = "Starter";
  } else if (avgMonthlyRevenueUSD <= 10000) {
    totalTestBudgetUSD = Math.min(avgMonthlyRevenueUSD * 0.12, 800);
    tier = "Growth";
  } else {
    totalTestBudgetUSD = Math.min(avgMonthlyRevenueUSD * 0.07, 2000);
    tier = "Scale";
  }
  const totalDailySpendUSD = totalTestBudgetUSD / LEGACY_TEST_DURATION_DAYS; // :1251

  // :1268-1278: product price, else store AOV, else median catalog price, else 25 USD.
  const effectiveAOV = hasProduct ? (input.productPrice as number) : aov > 0 ? aov : median > 0 ? median : 25 * fx;
  const aovUSD = effectiveAOV / fx;
  const aovGuardrailUSD = aovUSD * 0.5;

  const premiumPriceWarning = aovGuardrailUSD > totalDailySpendUSD * 3; // :1283
  const finalDailyUSD = legacyEstimateDailyTestBudget(totalDailySpendUSD, aovUSD); // :1290
  const recommendedDaily = Math.round(finalDailyUSD * fx); // :1292-1293
  const isAovPaced = finalDailyUSD === aovGuardrailUSD && aovGuardrailUSD > totalDailySpendUSD; // :1390

  return {
    path: "revenue_tier",
    tier,
    totalTestBudgetUSD,
    baselineDailyUSD: totalDailySpendUSD,
    effectivePrice: effectiveAOV,
    priceGuardrailUSD: aovGuardrailUSD,
    finalDailyUSD,
    recommendedDaily,
    selectedRule: isAovPaced ? "price_guardrail" : "revenue_tier_baseline",
    premiumPriceWarning,
    highBudgetWarning: !premiumPriceWarning && finalDailyUSD > 50, // :1431
    warningsShown: input.orderCount >= 20, // :1655, :1749-1751
    strategies: [ // :1363-1388
      { label: "Dip Your Toe", daily: Math.round(finalDailyUSD * 0.7 * fx) },
      { label: "Sweet Spot", daily: recommendedDaily },
      { label: "Full Send", daily: Math.round(finalDailyUSD * 1.4 * fx) },
    ],
    internationalRecommendedDaily: legacyInternationalStrategies(fx)[1].daily, // :1734
    durationDays: LEGACY_TEST_DURATION_DAYS,
  };
}

/** What each surface displays as the daily budget (architecture/phase-4-economics.md, step 8). */
export interface LegacySurfaceFigures {
  /** Brief data and PDF: campaigns/brief.ts:267-273, brief-html-template.ts:205. */
  briefAndPdfDaily: number;
  /** Budget planner: budget-planner.tsx:96-102. */
  plannerDaily: number;
  /** Targeting card: the engine's unadjusted Sweet Spot figure wins (targeting-summary.tsx:152-157). */
  targetingCardDaily: number;
  /** Plain-text export: brief.ts:531-576. */
  plainText: {
    daily: number;
    totalTestSpend: number;
    overseasDaily: number;
    combinedDaily: number;
    combinedTestSpend: number;
  };
  /** PDF decision tree: "scale" budget, daily × 1.2 (brief-html-template.ts:1408-1410). */
  pdfScaleDaily: number;
}

export function legacySurfaceFigures(
  engine: LegacyEngineResult,
  options: { goal?: LegacyGoal; strategyIndex?: 0 | 1 | 2; durationDays?: number; overseasStrategyIndex?: 0 | 1 | 2; exchangeRate: number },
): LegacySurfaceFigures {
  const goal = options.goal ?? "Drive Website Sales";
  const mult = LEGACY_GOAL_MULTIPLIERS[goal];
  const strategy = engine.strategies[options.strategyIndex ?? 1] ?? engine.strategies[1];
  const duration = options.durationDays ?? engine.durationDays;
  const adSets = 1; // the engine always returns one ad set (:1305, :1311)
  const adjusted = Math.round(strategy.daily * adSets * mult);
  const overseasDaily = legacyInternationalStrategies(options.exchangeRate)[options.overseasStrategyIndex ?? 1].daily;
  return {
    briefAndPdfDaily: adjusted,
    plannerDaily: Math.round(strategy.daily * mult),
    targetingCardDaily: engine.recommendedDaily,
    plainText: {
      daily: adjusted,
      totalTestSpend: adjusted * duration,
      overseasDaily,
      combinedDaily: adjusted + overseasDaily,
      combinedTestSpend: adjusted * duration + overseasDaily * duration,
    },
    pdfScaleDaily: Math.round(adjusted * 1.2),
  };
}

/** Plain-text export with no engine budget (brief.ts:579). */
export const LEGACY_PLAIN_TEXT_FALLBACK_DAILY = 5000;

/**
 * Production's unit-cost figure (shopify-intelligence.ts:625-636,
 * connectors/shopify.ts:727, :820): the first variant's price less the plain
 * average of the costed variants' costs. No currency check, no sales
 * weighting, variants without a cost ignored.
 */
export function legacyPriceLessUnitCost(variants: Array<{ price: number; unitCost: number | null }>): number | null {
  if (variants.length === 0) return null;
  const costs = variants.map((v) => v.unitCost).filter((c): c is number => c !== null && Number.isFinite(c));
  if (costs.length === 0) return null;
  return variants[0].price - costs.reduce((total, cost) => total + cost, 0) / costs.length;
}

/**
 * The PDF's "target ad spend per sale" (brief-html-template.ts:1411-1416):
 * price less unit cost, labelled "keeps each order profitable", else 35% of the price.
 */
export function legacyPdfTargetSpendPerSale(productPrice: number, priceLessUnitCost: number | null):
  { amount: number | null; basis: "price_less_unit_cost" | "35_percent_of_price" | "none"; label: string } {
  if (priceLessUnitCost !== null) {
    return { amount: priceLessUnitCost, basis: "price_less_unit_cost", label: "keeps each order profitable" };
  }
  if (productPrice > 0) return { amount: Math.round(productPrice * 0.35), basis: "35_percent_of_price", label: "~35% of piece price" };
  return { amount: null, basis: "none", label: "Keep ad spend per sale comfortably under your product profit margin" };
}
