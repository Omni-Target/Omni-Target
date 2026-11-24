import "server-only";
import { ECONOMICS_CALC_VERSION } from "./contribution";
import { acquisitionFromCampaigns, commitmentsFromCampaigns, evaluateCampaign, normaliseCampaigns, type CampaignFeedback } from "./feedback";
import { resolveMerchantInputs } from "./inputs";
import type { ProductRecommendation } from "./recommend";
import { adCampaignsWithResults, economicsInputs, economicsPolicy, economicsRun, productEconomicsEvidence, recordEconomicsRun } from "./repository";
import { recordedRows, runEconomics, runSummary, type EconomicsRunResult } from "./run";

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
}): Promise<{ runId: string; policyVersion: number; result: EconomicsRunResult }> {
  const asOf = params.asOf ?? new Date();
  const ids = [...new Set(params.productIds)].slice(0, 200);
  if (!ids.length) throw new Error("runAndRecordEconomics: no products");
  const policy = await economicsPolicy();
  const [stored, evidence, rawCampaigns] = await Promise.all([
    economicsInputs(params.shopKey, ids), productEconomicsEvidence(params.shopKey, ids, asOf, policy), adCampaignsWithResults(params.shopKey)]);
  if (!evidence.products.length) throw new Error("runAndRecordEconomics: none of the products exist");
  if (!evidence.currency) throw new Error("runAndRecordEconomics: the shop's currency is not known");
  const campaigns = normaliseCampaigns(rawCampaigns);
  const resolve = (productId: number) => resolveMerchantInputs(stored, productId, { now: asOf, staleDays: policy.settings.merchant_inputs_stale_days });
  const result = runEconomics({
    evidence,
    products: evidence.products.map((product) => ({ product, inputs: resolve(product.product_id),
      acquisition: acquisitionFromCampaigns(campaigns, product.product_id, evidence.currency as string, asOf.toISOString(), policy.settings),
      targetMarketServiced: params.targetMarketServiced ?? null })),
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
  const { result } = await runAndRecordEconomics({ shopKey: params.shopKey, productIds, trigger: "check", requestedBy: params.requestedBy, asOf });
  const current = new Map(result.recommendations.map((r) => [r.product_id, r.output]));
  const policy = await economicsPolicy();
  const stored = await economicsInputs(params.shopKey, []);
  const dailyLimit = resolveMerchantInputs(stored, 0, { now: asOf, staleDays: policy.settings.merchant_inputs_stale_days }).ad_daily_limit.value;
  const currency = result.recommendations[0]?.output.economics.currency;
  if (!currency) return [];
  const feedback: CampaignFeedback[] = [];
  for (const campaign of campaigns) {
    let atLaunch: ProductRecommendation[] | undefined;
    if (campaign.recommendation_run_id) {
      const run = await economicsRun(params.shopKey, campaign.recommendation_run_id);
      atLaunch = run?.recommendations.filter((r) => campaign.product_ids.includes(r.product_id)).map((r) => r.outputs as ProductRecommendation);
    }
    feedback.push(evaluateCampaign({ campaign, shopCurrency: currency, current: campaign.product_ids.map((id) => current.get(id)).filter((r): r is ProductRecommendation => !!r),
      atLaunch, dailyLimit, policy: policy.settings, asOf: asOf.toISOString() }));
  }
  return feedback;
}
