/**
 * Verdict, confidence and budget for one product (Phase 4, task 5; architecture/phase-4-economics.md,
 * "Inputs, provenance and confidence", "Verdicts" and "Budget").
 *
 * Pure and deterministic. Economics come first: a product is judged on whether one sale can pay for its
 * acquisition, and only then is a budget sized, as the smallest of what the merchant authorised, what stock can
 * fulfil, what the portfolio leaves and what the policy allows for learning. Blocked and unviable products get
 * exactly zero; products with missing inputs get no amounts at all.
 */
import { computeProductEconomics, ECONOMICS_CALC_VERSION, type ContributionArgs, type ProductEconomics } from "./contribution";
import { money } from "./money";
import type { ReasonCode } from "./reasons";

export type Verdict = "GO" | "PILOT" | "DO_NOT_LAUNCH" | "INSUFFICIENT_DATA" | "BLOCKED";
export type EconomicsConfidence = "high" | "medium" | "low";
export type AcquisitionEvidenceClass = "proven" | "indicative" | "established_demand" | "unproven";
export type Constraint = "merchant" | "inventory" | "portfolio" | "policy";

/** Measured campaign results for the product (task 7), in the shop's currency, matured days only. */
export interface AcquisitionEvidence {
  matured_conversions: number;
  matured_spend: number;
  cpa: number | null;
  /** Bounds at the policy's decision confidence (exact Poisson on the conversion count). */
  cpa_lower: number | null;
  cpa_upper: number | null;
  /** Recent days not judged yet. */
  immature_days: number;
}

export interface RecommendArgs extends ContributionArgs {
  /** Results of tracked campaigns, if any. */
  acquisition?: AcquisitionEvidence | null;
  /** Whether an active market and shipping zone serve the target country; null when not known. */
  targetMarketServiced?: boolean | null;
  /** What the portfolio leaves for this product (task 6); null when the merchant set no monthly limit. */
  portfolioLimit?: number | null;
  /** The test length the merchant chose (7, 14 or 30), else the policy default. */
  testDays?: number;
  /** When the evidence was read; inventory freshness is judged against it. */
  asOf: string;
  freshness: { inventory?: string | null };
}

export interface BudgetRecommendation {
  /** recommended: amounts below; zero: nothing to spend; withheld: no amounts (data missing); awaiting_authority: the merchant set no limit. */
  status: "recommended" | "zero" | "withheld" | "awaiting_authority";
  kind: "pilot" | "controlled_test" | null;
  test_budget: number | null;
  daily_budget: number | null;
  test_days: number | null;
  /** Decided after the test, from its results (task 7). */
  ongoing_budget: number | null;
  max_experimental_loss: number | null;
  ceilings: Record<Constraint, number | null>;
  binding: Constraint | null;
  /** Sales the test budget buys if the cost per sale is exactly the target: a sizing figure, not a forecast. */
  sales_at_target_cpa: number | null;
  inventory: { sellable_units: number | null; organic_reserve_units: number; units_for_ads: number | null; max_orders: number | null } | null;
}

export interface ProductRecommendation {
  calc_version: typeof ECONOMICS_CALC_VERSION;
  product_id: number;
  verdict: Verdict;
  /** Why this verdict, most important first. */
  reasons: ReasonCode[];
  /** Everything else worth knowing: proxies, estimates, constraints. */
  notes: ReasonCode[];
  confidence: { economics: EconomicsConfidence | null; acquisition: AcquisitionEvidenceClass; overall: EconomicsConfidence | null; why: string[] };
  economics: ProductEconomics;
  budget: BudgetRecommendation;
}

const DOWNGRADING_NOTES: ReasonCode[] = ["DISCOUNT_RATE_STORE_PROXY", "DISCOUNT_RATE_MERCHANT_ESTIMATE", "RETURN_RATE_STORE_PROXY",
  "RETURN_RATE_MERCHANT_ESTIMATE", "COST_SETTINGS_STALE", "INVENTORY_STALE", "UNPAID_SHARE_UNOBSERVED"];

export function recommendProduct(args: RecommendArgs): ProductRecommendation {
  const { product, inputs, policy } = args;
  const economics = computeProductEconomics(args);
  const reasons: ReasonCode[] = [];
  const notes = new Set<ReasonCode>(economics.notes);
  const m = money(economics.currency ?? "USD");
  const acquisition = args.acquisition ?? null;

  // ── Inventory facts (used by the restrictions and the budget) ──
  const states = product.inventory.map((i) => i.state);
  const untracked = states.includes("untracked");
  const oversell = states.includes("oversell_allowed");
  const inStock = states.includes("in_stock");
  const outOfStock = !untracked && !inStock && !oversell && states.length > 0 && states.every((s) => s === "out_of_stock" || s === "unknown")
    && states.includes("out_of_stock");
  if (untracked) notes.add("INVENTORY_UNTRACKED");
  if (!untracked && !inStock && !oversell && states.includes("unknown")) notes.add("INVENTORY_UNKNOWN");
  if (oversell) notes.add("INVENTORY_OVERSELL_ALLOWED");
  const inventoryRead = args.freshness.inventory ? Date.parse(args.freshness.inventory) : NaN;
  if (!untracked && (!Number.isFinite(inventoryRead) || Date.parse(args.asOf) - inventoryRead > policy.inventory_stale_hours * 3_600_000)) {
    notes.add("INVENTORY_STALE");
  }

  // ── Confidence ──
  const why: string[] = [];
  let economicsConfidence: EconomicsConfidence | null = null;
  if (economics.contribution !== null) {
    if (product.sales.orders < policy.medium_confidence_orders) {
      economicsConfidence = "low";
      why.push(`${product.sales.orders} product orders in ${policy.sales_window_days} days (medium needs ${policy.medium_confidence_orders})`);
    } else {
      const downgrades = DOWNGRADING_NOTES.filter((n) => notes.has(n));
      if (product.sales.orders < policy.high_confidence_orders) why.push(`${product.sales.orders} product orders (high needs ${policy.high_confidence_orders})`);
      for (const n of downgrades) why.push(n);
      economicsConfidence = downgrades.length || product.sales.orders < policy.high_confidence_orders ? "medium" : "high";
    }
  }
  let acquisitionClass: AcquisitionEvidenceClass = "unproven";
  if (acquisition && acquisition.matured_conversions >= policy.proven_conversions) acquisitionClass = "proven";
  else if (acquisition && acquisition.matured_conversions > 0) acquisitionClass = "indicative";
  else if (product.sales.demand_orders >= policy.established_demand_orders) acquisitionClass = "established_demand";
  const overall: EconomicsConfidence | null = economicsConfidence === null ? null
    : economicsConfidence === "high" && acquisitionClass === "proven" ? "high"
    : economicsConfidence !== "low" && acquisitionClass !== "unproven" ? "medium" : "low";

  // ── Verdict, in order: restrictions, unviable economics, missing data, proven, pilot ──
  const restrictions: ReasonCode[] = [];
  if (product.product.status !== "active") restrictions.push("PRODUCT_NOT_ACTIVE");
  if (product.product.is_gift_card) restrictions.push("GIFT_CARD");
  if (product.variants.length > 0 && product.variants.every((v) => !(v.price > 0))) restrictions.push("ZERO_PRICE");
  if (outOfStock) restrictions.push("OUT_OF_STOCK");
  if (args.targetMarketServiced === false) restrictions.push("TARGET_MARKET_NOT_SERVICED");
  if (inputs.advertising_excluded.value === 1) restrictions.push("MERCHANT_EXCLUDED");

  const be = economics.break_even_cpa;
  const target = economics.target_cpa;
  let verdict: Verdict;
  if (restrictions.length) {
    verdict = "BLOCKED";
    reasons.push(...restrictions);
  } else if ((economics.contribution !== null && economics.contribution <= 0)
    || (economics.contribution === null && economics.contribution_upper_bound !== null && economics.contribution_upper_bound <= 0)) {
    // Missing costs can only lower contribution: a bound at or below zero settles it.
    verdict = "DO_NOT_LAUNCH";
    reasons.push("NEGATIVE_CONTRIBUTION_MARGIN");
  } else if (economics.missing.length) {
    verdict = "INSUFFICIENT_DATA";
    reasons.push(...economics.missing);
  } else if (acquisitionClass === "proven" && acquisition?.cpa_lower !== null && acquisition?.cpa_lower !== undefined && be !== null && acquisition.cpa_lower > be) {
    verdict = "DO_NOT_LAUNCH";
    reasons.push("CPA_ABOVE_BREAK_EVEN");
  } else if (acquisitionClass === "proven" && economicsConfidence !== "low" && acquisition!.cpa !== null && target !== null && be !== null
    && acquisition!.cpa <= target && acquisition!.cpa_upper !== null && acquisition!.cpa_upper <= be) {
    verdict = "GO";
  } else {
    verdict = "PILOT";
    if (acquisition && acquisition.cpa !== null && target !== null && acquisition.cpa > target) reasons.push("CPA_ABOVE_TARGET");
    else reasons.push("INSUFFICIENT_CONVERSION_EVIDENCE");
    if (product.sales.orders === 0) reasons.push("NO_SALES_HISTORY");
    if (acquisition && acquisition.immature_days > 0) notes.add("ATTRIBUTION_IMMATURE");
  }

  // ── Budget ──
  const ceilings: Record<Constraint, number | null> = { merchant: null, inventory: null, portfolio: null, policy: null };
  const empty = (status: BudgetRecommendation["status"]): BudgetRecommendation => ({
    status, kind: null, test_budget: status === "zero" ? 0 : null, daily_budget: status === "zero" ? 0 : null, test_days: null,
    ongoing_budget: status === "zero" ? 0 : null, max_experimental_loss: status === "zero" ? 0 : null, ceilings, binding: null,
    sales_at_target_cpa: null, inventory: null,
  });
  let budget: BudgetRecommendation;
  if (verdict === "BLOCKED" || verdict === "DO_NOT_LAUNCH") {
    budget = empty("zero");
  } else if (verdict === "INSUFFICIENT_DATA" || target === null || target <= 0) {
    budget = empty("withheld");
  } else {
    const kind = verdict === "GO" ? "controlled_test" : "pilot";
    const days = [7, 14, 30].includes(args.testDays ?? 0) ? (args.testDays as number) : policy.default_test_days;
    const targetMinor = m.down(target);

    // Policy: sized to learn, at the target cost per sale.
    ceilings.policy = m.major(targetMinor * (kind === "controlled_test" ? policy.test_conversions : policy.pilot_conversions));

    // Merchant: the test limit, and the loss limit (a test that sells nothing loses all it spends).
    const testLimit = inputs.ad_test_limit.value;
    const lossLimit = inputs.ad_max_loss.value;
    const merchantLimits = [testLimit, lossLimit].filter((v): v is number => v !== null);
    ceilings.merchant = merchantLimits.length ? m.major(m.down(Math.min(...merchantLimits))) : null;

    // Inventory: stock at online locations, less what organic demand will take during the test.
    let inventory: BudgetRecommendation["inventory"] = null;
    if (!untracked) {
      const sellable = product.inventory.reduce((t, i) => t + Math.max(0, i.state === "in_stock" || i.state === "oversell_allowed" ? i.online.available ?? 0 : 0), 0);
      const organicPerDay = policy.reserve_organic_demand
        ? Math.max(product.sales.recent_units / 30, product.sales.demand_units / policy.established_demand_window_days) : 0;
      const reserve = Math.ceil(organicPerDay * days - 1e-9);
      const forAds = Math.max(0, sellable - reserve);
      const maxOrders = Math.floor(forAds / Math.max(1, economics.units_per_order) + 1e-9);
      inventory = { sellable_units: sellable, organic_reserve_units: reserve, units_for_ads: forAds, max_orders: maxOrders };
      ceilings.inventory = m.major(targetMinor * maxOrders);
    }

    ceilings.portfolio = args.portfolioLimit === undefined || args.portfolioLimit === null ? null : m.major(m.down(Math.max(0, args.portfolioLimit)));

    const order: Constraint[] = ["merchant", "inventory", "portfolio", "policy"];
    const applicable = order.filter((c) => ceilings[c] !== null);
    const binding = applicable.reduce((best, c) => ((ceilings[c] as number) < (ceilings[best] as number) ? c : best), applicable[0]);
    const maximum = ceilings[binding] as number;
    const bindingReason: Record<Constraint, ReasonCode> = { merchant: "MERCHANT_LIMIT_BINDING", inventory: "INVENTORY_LIMITED",
      portfolio: "PORTFOLIO_LIMIT_REACHED", policy: "POLICY_LIMIT_BINDING" };

    if (ceilings.merchant === null) {
      notes.add("MERCHANT_AUTHORITY_MISSING");
      budget = { ...empty("awaiting_authority"), kind, ceilings, inventory };
    } else {
      const minimum = m.major(targetMinor * policy.min_test_conversions);
      notes.add(bindingReason[binding]);
      if (maximum < minimum) {
        notes.add("BUDGET_BELOW_MINIMUM_TEST");
        budget = { ...empty("zero"), kind, ceilings, binding, inventory };
      } else {
        let testMinor = m.down(maximum);
        let testDays = days;
        let dailyMinor = Math.floor(testMinor / testDays);
        const dailyLimit = inputs.ad_daily_limit.value;
        if (dailyLimit !== null && dailyMinor > m.down(dailyLimit)) {
          // The daily limit binds: run longer at the limit, up to the policy's longest test, then spend less.
          dailyMinor = m.down(dailyLimit);
          // Whole days at the limit, so daily × days never exceeds what was authorised.
          testDays = Math.min(policy.max_test_days, Math.floor(testMinor / Math.max(1, dailyMinor)));
          testMinor = dailyMinor * testDays;
          notes.add("MERCHANT_LIMIT_BINDING");
        }
        if (testMinor < targetMinor * policy.min_test_conversions) {
          // Even the longest test at the merchant's daily limit cannot buy enough sales to learn from.
          notes.add("BUDGET_BELOW_MINIMUM_TEST");
          budget = { ...empty("zero"), kind, ceilings, binding: "merchant", inventory };
        } else budget = {
          status: "recommended", kind,
          test_budget: m.major(testMinor), daily_budget: m.major(dailyMinor), test_days: testDays, ongoing_budget: null,
          // The merchant's authorised loss limit (the stop rule's line); without one, the test budget is the most it can lose.
          max_experimental_loss: lossLimit !== null ? m.major(m.down(lossLimit)) : m.major(testMinor),
          ceilings, binding, sales_at_target_cpa: Math.round((testMinor / targetMinor) * 10) / 10, inventory,
        };
      }
    }
  }

  return {
    calc_version: ECONOMICS_CALC_VERSION,
    product_id: product.product_id,
    verdict,
    reasons,
    notes: [...notes].filter((n) => !reasons.includes(n)),
    confidence: { economics: economicsConfidence, acquisition: acquisitionClass, overall, why },
    economics,
    budget,
  };
}
