import "server-only";
import { ECONOMICS_CALC_VERSION } from "./contribution";
import { acquisitionFromCampaigns, commitmentsFromCampaigns, evaluateCampaign, normaliseCampaigns, type CampaignFeedback } from "./feedback";
import { resolveMerchantInputs, resolveVariantInputs } from "./inputs";
import type { ProductRecommendation } from "./recommend";
import { adCampaignsWithResults, campaignReconciliationEvidence, economicsInputs, economicsPolicy, economicsRun, productEconomicsEvidence, recordAdCampaignEvaluations,
  recordEconomicsRun, refundMaturityDays,
  storeRefundLag } from "./repository";
import { recordedRows, runEconomics, runSummary, type EconomicsRunResult } from "./run";
import { assessServiceability } from "@/modules/intelligence/serviceability";
import { shopMarketContext } from "@/modules/intelligence/repository";
import type { ProductEvidence } from "./evidence";

/** Whether a product is shipped: true if any variant is, false if none is, null when not known. */
const requiresShipping = (p: ProductEvidence): boolean | null =>
  p.variants.some((v) => v.requires_shipping === true) ? true : p.variants.length > 0 && p.variants.every((v) => v.requires_shipping === false) ? false : null;

/**
 * Runs the economics engine for a shop's products and records the run (Phase 4, tasks 6–7). Everything is read
 * from the database: the active policy, the merchant's inputs, the evidence, and tracked campaigns (their
 * results as acquisition evidence, their remaining spend as portfolio commitments).
 */
export async function runAndRecordEconomics(params: {
  shopKey: number;
  productIds: number[];
  trigger: "brief" | "portfolio" | "check";
  requestedBy: string | null;
  testDays?: number;
  asOf?: Date;
  targetMarketServiced?: boolean | null;
  /** Phase 5: the country the products are to be advertised in; the shop's own country when not given. */
  targetCountry?: string | null;
}): Promise<{ runId: string; policyVersion: number; result: EconomicsRunResult }> {
  const asOf = params.asOf ?? new Date();
  const ids = [...new Set(params.productIds)].slice(0, 200);
  if (!ids.length) throw new Error("runAndRecordEconomics: no products");
  const policy = await economicsPolicy();
  // Policy version 2: refund maturity follows how long this store's refunds actually take.
  const lag = policy.settings.refund_lag_min_refunds !== undefined ? await storeRefundLag(params.shopKey, asOf, policy.settings.sales_window_days) : null;
  const maturity = refundMaturityDays(policy.settings, lag);
  const [stored, evidence, rawCampaigns] = await Promise.all([
    economicsInputs(params.shopKey, ids), productEconomicsEvidence(params.shopKey, ids, asOf, policy, maturity), adCampaignsWithResults(params.shopKey)]);
  if (!evidence.products.length) throw new Error("runAndRecordEconomics: none of the products exist");
  if (!evidence.currency) throw new Error("runAndRecordEconomics: the shop's currency is not known");
  const campaigns = normaliseCampaigns(rawCampaigns);
  const marketContext = params.targetMarketServiced == null ? await shopMarketContext(params.shopKey).catch(() => null) : null;
  const resolve = (productId: number) => resolveMerchantInputs(stored, productId, { now: asOf, staleDays: policy.settings.merchant_inputs_stale_days });
  const result = runEconomics({
    evidence,
    products: evidence.products.map((product) => ({ product, inputs: resolve(product.product_id),
      variantInputs: resolveVariantInputs(stored, product.product_id, { now: asOf, staleDays: policy.settings.merchant_inputs_stale_days }),
      acquisition: acquisitionFromCampaigns(campaigns, product.product_id, evidence.currency as string, asOf.toISOString(), policy.settings),
      targetMarketServiced: params.targetMarketServiced ?? null,
      // Phase 5: can the product be sold and delivered to the target country? Not known when the context is missing.
      ...(marketContext ? { market: assessServiceability(marketContext, { requires_shipping: requiresShipping(product) }, params.targetCountry) } : {}) })),
    policy: policy.settings,
    commitments: commitmentsFromCampaigns(campaigns, evidence.currency, policy.settings),
    monthlyLimit: resolve(0).ad_monthly_limit.value,
    testDays: params.testDays,
  });
  const runId = await recordEconomicsRun(params.shopKey, {
    as_of: asOf.toISOString(), calc_version: ECONOMICS_CALC_VERSION, policy_version: policy.version, trigger: params.trigger,
    requested_by: params.requestedBy, portfolio: result.portfolio, summary: runSummary(result),
  }, recordedRows(result));
  return { runId, policyVersion: policy.version, result };
}

/** Judges each active campaign against fresh economics and the recommendations that authorised it. */
export async function evaluateShopCampaigns(params: { shopKey: number; requestedBy: string | null; asOf?: Date }): Promise<CampaignFeedback[]> {
  const asOf = params.asOf ?? new Date();
  const campaigns = normaliseCampaigns(await adCampaignsWithResults(params.shopKey)).filter((c) => c.status === "active");
  if (!campaigns.length) return [];
  const productIds = [...new Set(campaigns.flatMap((c) => c.product_ids))];
  const { runId, result } = await runAndRecordEconomics({ shopKey: params.shopKey, productIds, trigger: "check", requestedBy: params.requestedBy, asOf });
  const current = new Map(result.recommendations.map((r) => [r.product_id, r.output]));
  const policy = await economicsPolicy();
  const stored = await economicsInputs(params.shopKey, []);
  const dailyLimit = resolveMerchantInputs(stored, 0, { now: asOf, staleDays: policy.settings.merchant_inputs_stale_days }).ad_daily_limit.value;
  const currency = result.recommendations[0]?.output.economics.currency;
  if (!currency) return [];
  const feedback: CampaignFeedback[] = [];
  const recorded: Parameters<typeof recordAdCampaignEvaluations>[1] = [];
  for (const campaign of campaigns) {
    let atLaunch: ProductRecommendation[] | undefined;
    if (campaign.recommendation_run_id) {
      const run = await economicsRun(params.shopKey, campaign.recommendation_run_id);
      atLaunch = run?.recommendations.filter((r) => campaign.product_ids.includes(r.product_id)).map((r) => r.outputs as ProductRecommendation);
    }
    // Policy version 3: what Shopify recorded over the campaign's period, to reconcile Meta's purchase count before any increase.
    const reconciliation = policy.settings.scale_confidence !== undefined
      ? await campaignReconciliationEvidence(params.shopKey, campaign.id, asOf).catch(() => null) : undefined;
    const args: Parameters<typeof evaluateCampaign>[0] = { campaign, shopCurrency: currency,
      current: campaign.product_ids.map((id) => current.get(id)).filter((r): r is ProductRecommendation => !!r),
      atLaunch, dailyLimit, policy: policy.settings, asOf: asOf.toISOString(), ...(reconciliation !== undefined ? { reconciliation } : {}) };
    const output = evaluateCampaign(args);
    feedback.push(output);
    // Every evaluation is recorded with its policy, calc version and full arguments, so it recomputes.
    recorded.push({ campaign_id: campaign.id, run_id: runId, as_of: args.asOf, policy_version: policy.version,
      calc_version: args.current[0]?.economics.calc_version ?? "econ-1.0.0", action: output.action, inputs: args, output });
  }
  if (recorded.length) await recordAdCampaignEvaluations(params.shopKey, recorded, params.requestedBy);
  return feedback;
}
