/**
 * One economics run over several products (Phase 4, task 6): each product's recommendation on its own, then the
 * portfolio allocation, then each candidate again with its allocation as the portfolio ceiling, so the final
 * budgets sum to no more than the merchant's limit. Pure: the service (service.ts) loads the inputs and records
 * the run. Every recommendation keeps the exact arguments that produced it, so it can be recomputed.
 */
import type { EconomicsEvidence, ProductEvidence } from "./evidence";
import type { ResolvedInputs } from "./inputs";
import type { VariantInputs } from "./contribution";
import type { EconomicsPolicySettings } from "./policy";
import { allocatePortfolio, type Commitment, type PortfolioAllocation } from "./portfolio";
import { recommendProduct, type AcquisitionEvidence, type ProductRecommendation, type RecommendArgs } from "./recommend";
import { servicedFlag, type MarketServiceability } from "@/modules/intelligence/serviceability";

export interface ProductRunInput {
  product: ProductEvidence;
  inputs: ResolvedInputs;
  acquisition?: AcquisitionEvidence | null;
  targetMarketServiced?: boolean | null;
  /** Phase 5: the target market's serviceability; sets targetMarketServiced when that is not given. */
  market?: MarketServiceability;
  /** Per-variant inputs (0056). */
  variantInputs?: VariantInputs;
}

export interface RecordedRecommendation {
  product_id: number;
  /** Exactly what recommendProduct received. */
  args: RecommendArgs;
  output: ProductRecommendation;
}

export interface EconomicsRunResult {
  recommendations: RecordedRecommendation[];
  portfolio: PortfolioAllocation | null;
}

export function runEconomics(args: {
  evidence: Pick<EconomicsEvidence, "currency" | "taxes_included" | "store" | "freshness" | "as_of">;
  products: ProductRunInput[];
  policy: EconomicsPolicySettings;
  commitments: Commitment[];
  /** The merchant's advertising limit for the period (shop-wide); null when not set. */
  monthlyLimit: number | null;
  testDays?: number;
}): EconomicsRunResult {
  const funded = new Set(args.commitments.flatMap((c) => c.product_ids));
  const base = (p: ProductRunInput, portfolioLimit: number | null): RecommendArgs => ({
    evidence: { currency: args.evidence.currency, taxes_included: args.evidence.taxes_included, store: args.evidence.store },
    product: p.product, inputs: p.inputs, ...(p.variantInputs && Object.keys(p.variantInputs).length ? { variantInputs: p.variantInputs } : {}),
    policy: args.policy, acquisition: p.acquisition ?? null,
    targetMarketServiced: p.targetMarketServiced ?? (p.market ? servicedFlag(p.market) : null), ...(p.market ? { market: p.market } : {}),
    portfolioLimit, testDays: args.testDays,
    alreadyFunded: funded.has(p.product.product_id), asOf: args.evidence.as_of, freshness: { inventory: args.evidence.freshness.inventory ?? null },
  });
  const first = args.products.map((p) => recommendProduct(base(p, null)));
  if (args.monthlyLimit === null || !args.evidence.currency) {
    return { recommendations: args.products.map((p, i) => ({ product_id: p.product.product_id, args: base(p, null), output: first[i] })), portfolio: null };
  }
  const cpaUpper = new Map(args.products.filter((p) => p.acquisition?.cpa_upper != null).map((p) => [p.product.product_id, p.acquisition!.cpa_upper as number]));
  const portfolio = allocatePortfolio({ currency: args.evidence.currency, recommendations: first, cpaUpper, commitments: args.commitments,
    monthlyLimit: args.monthlyLimit, policy: args.policy });
  const allocated = new Map(portfolio.allocations.filter((a) => a.rank !== null).map((a) => [a.product_id, a.allocated]));
  const recommendations = args.products.map((p, i) => {
    const share = allocated.get(p.product.product_id);
    if (share === undefined) return { product_id: p.product.product_id, args: base(p, null), output: first[i] };
    const finalArgs = base(p, share);
    return { product_id: p.product.product_id, args: finalArgs, output: recommendProduct(finalArgs) };
  });
  return { recommendations, portfolio };
}

/** Recomputes a recorded recommendation from its recorded arguments (the reproducibility check). */
export const recompute = (recorded: RecordedRecommendation) => recommendProduct(recorded.args);

/** The rows record_economics_run stores (migration 0054): headline columns plus the full arguments and output. */
export function recordedRows(result: EconomicsRunResult) {
  return result.recommendations.map(({ product_id, args, output }) => ({
    product_id,
    verdict: output.verdict,
    reasons: output.reasons,
    currency: output.economics.currency,
    budget_status: output.budget.status,
    test_budget: output.budget.test_budget,
    daily_budget: output.budget.daily_budget,
    test_days: output.budget.test_days,
    break_even_cpa: output.economics.break_even_cpa,
    target_cpa: output.economics.target_cpa,
    inputs: args,
    outputs: output,
  }));
}

/** Counts by verdict and the total recommended, for the run's summary. */
export function runSummary(result: EconomicsRunResult) {
  const verdicts: Record<string, number> = {};
  let total = 0;
  for (const { output } of result.recommendations) {
    verdicts[output.verdict] = (verdicts[output.verdict] ?? 0) + 1;
    total += Math.round((output.budget.test_budget ?? 0) * 1e6);
  }
  return { verdicts, recommended_total: total / 1e6 };
}
