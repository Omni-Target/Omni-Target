import "server-only";
import { ECONOMICS_CALC_VERSION } from "./contribution";
import { resolveMerchantInputs } from "./inputs";
import type { Commitment } from "./portfolio";
import type { AcquisitionEvidence } from "./recommend";
import { economicsInputs, economicsPolicy, productEconomicsEvidence, recordEconomicsRun } from "./repository";
import { recordedRows, runEconomics, runSummary, type EconomicsRunResult } from "./run";

/**
 * Runs the economics engine for a shop's products and records the run (Phase 4, task 6). Everything is read
 * from the database: the active policy, the merchant's inputs and the evidence. Campaign results and existing
 * commitments come from task 7's tracking when it supplies them.
 */
export async function runAndRecordEconomics(params: {
  shopKey: number;
  productIds: number[];
  trigger: "brief" | "portfolio" | "check";
  requestedBy: string | null;
  testDays?: number;
  asOf?: Date;
  acquisition?: Map<number, AcquisitionEvidence>;
  commitments?: Commitment[];
  targetMarketServiced?: boolean | null;
}): Promise<{ runId: string; policyVersion: number; result: EconomicsRunResult }> {
  const asOf = params.asOf ?? new Date();
  const ids = [...new Set(params.productIds)].slice(0, 200);
  if (!ids.length) throw new Error("runAndRecordEconomics: no products");
  const policy = await economicsPolicy();
  const [stored, evidence] = await Promise.all([economicsInputs(params.shopKey, ids), productEconomicsEvidence(params.shopKey, ids, asOf, policy)]);
  if (!evidence.products.length) throw new Error("runAndRecordEconomics: none of the products exist");
  const resolve = (productId: number) => resolveMerchantInputs(stored, productId, { now: asOf, staleDays: policy.settings.merchant_inputs_stale_days });
  const result = runEconomics({
    evidence,
    products: evidence.products.map((product) => ({ product, inputs: resolve(product.product_id),
      acquisition: params.acquisition?.get(product.product_id) ?? null, targetMarketServiced: params.targetMarketServiced ?? null })),
    policy: policy.settings,
    commitments: params.commitments ?? [],
    monthlyLimit: resolve(0).ad_monthly_limit.value,
    testDays: params.testDays,
  });
  const runId = await recordEconomicsRun(params.shopKey, {
    as_of: asOf.toISOString(), calc_version: ECONOMICS_CALC_VERSION, policy_version: policy.version, trigger: params.trigger,
    requested_by: params.requestedBy, portfolio: result.portfolio, summary: runSummary(result),
  }, recordedRows(result));
  return { runId, policyVersion: policy.version, result };
}
