import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import { parseEconomicsPolicy, type EconomicsPolicy } from "./policy";
import type { MerchantInputKey, StoredMerchantInputs } from "./inputs";
import { normaliseEvidence, type EconomicsEvidence } from "./evidence";
import { normaliseReconciliationEvidence, type ReconciliationEvidence } from "./reconciliation";
export { refundMaturityDays } from "./repository-pure";

/** The economics policy and the merchant's inputs (Phase 4, task 2; migration 0052). */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}

/** A policy version, or the active one; checked before use. */
export async function economicsPolicy(version: number | null = null): Promise<EconomicsPolicy> {
  const raw = await rpc<unknown>("economics_policy", { p_version: version });
  if (!raw) throw new Error(version === null ? "no active economics policy" : `economics policy ${version} not found`);
  return parseEconomicsPolicy(raw);
}

/** The shop's currency, its shop-wide inputs and the overrides for these products. */
export const economicsInputs = (shopKey: number, productIds: number[]) =>
  rpc<StoredMerchantInputs>("economics_inputs", { p_shop_key: shopKey, p_product_ids: productIds.slice(0, 1000) });

export type MerchantInputChange =
  | { product_id?: number; variant_id?: number; key: MerchantInputKey; value: number; state: "merchant_entered" | "confirmed_none" | "merchant_estimate" }
  | { product_id?: number; variant_id?: number; key: MerchantInputKey; state: "cleared" };

/** The product's variants whose Shopify unit cost is exactly zero (the ones a merchant may confirm as genuinely free). */
export async function zeroCostVariantIds(shopKey: number, productId: number): Promise<number[]> {
  const { data, error } = await supabaseAdmin.from("product_variants").select("shopify_id")
    .eq("shop_key", shopKey).eq("product_shopify_id", productId).eq("unit_cost", 0).limit(250);
  if (error) throw new Error(`product_variants: ${error.message}`);
  return (data ?? []).map((v) => Number(v.shopify_id));
}

/** Saves or clears inputs, all or none; the database checks each against the catalogue. */
export const saveEconomicsInputs = (shopKey: number, changes: MerchantInputChange[], enteredBy: string) =>
  rpc<{ saved: number; cleared: number }>("save_economics_inputs", { p_shop_key: shopKey, p_inputs: changes, p_entered_by: enteredBy });

/** The economics evidence for at most 200 products, over the windows the policy sets (migration 0053). */
export async function productEconomicsEvidence(shopKey: number, productIds: number[], asOf: Date, policy: EconomicsPolicy,
  maturityDays: number = policy.settings.return_maturity_days): Promise<EconomicsEvidence> {
  const s = policy.settings;
  const raw = await rpc<EconomicsEvidence>("product_economics_evidence", {
    p_shop_key: shopKey, p_product_ids: productIds.slice(0, 200), p_as_of: asOf.toISOString(),
    p_sales_window_days: s.sales_window_days, p_discount_window_days: s.discount_window_days,
    p_maturity_days: maturityDays, p_demand_window_days: s.established_demand_window_days,
  });
  return normaliseEvidence(raw);
}

/** Records a run and its recommendations, all or none (migration 0054). */
export const recordEconomicsRun = (shopKey: number, run: Record<string, unknown>, recommendations: Record<string, unknown>[]) =>
  rpc<string>("record_economics_run", { p_shop_key: shopKey, p_run: run, p_recommendations: recommendations });

/** A recorded run with each recommendation's arguments and output. */
export const economicsRun = (shopKey: number, runId: string) =>
  rpc<{ run: Record<string, unknown>; recommendations: Array<{ product_id: number; inputs: unknown; outputs: unknown }> } | null>(
    "economics_run", { p_shop_key: shopKey, p_run_id: runId });

/** Each product's latest recorded recommendation. */
export const latestProductRecommendations = (shopKey: number, productIds: number[]) =>
  rpc<Array<{ product_id: number; run_id: string; created_at: string; verdict: string; outputs: unknown }>>(
    "latest_product_recommendations", { p_shop_key: shopKey, p_product_ids: productIds.slice(0, 200) });

/** Tracked campaigns and their daily results (migration 0055). Nothing is published or spent. */
export const saveAdCampaign = (shopKey: number, campaign: Record<string, unknown>, by: string) =>
  rpc<string>("save_ad_campaign", { p_shop_key: shopKey, p_campaign: campaign, p_by: by });

export const saveAdCampaignResults = (shopKey: number, campaignId: string, days: Record<string, unknown>[], by: string) =>
  rpc<{ saved: number }>("save_ad_campaign_results", { p_shop_key: shopKey, p_campaign_id: campaignId, p_days: days, p_by: by, p_source: "merchant_entered" });

export const adCampaignsWithResults = (shopKey: number, campaignIds: string[] | null = null) =>
  rpc<unknown[]>("ad_campaigns_with_results", { p_shop_key: shopKey, p_campaign_ids: campaignIds });

/** How long the store's refunds take (0056): refunds on orders in the window, and their median and 90th-percentile lag in days. */
export const storeRefundLag = (shopKey: number, asOf: Date, windowDays: number) =>
  rpc<{ refunds: number; p90_days: number | null; p50_days: number | null }>("store_refund_lag",
    { p_shop_key: shopKey, p_as_of: asOf.toISOString(), p_window_days: windowDays });


/** What Shopify recorded over a campaign's period, for reconciling Meta's purchase count (0058); null when the campaign is not the shop's. */
export const campaignReconciliationEvidence = async (shopKey: number, campaignId: string, asOf: Date): Promise<ReconciliationEvidence | null> =>
  normaliseReconciliationEvidence(await rpc<unknown>("campaign_reconciliation_evidence", { p_shop_key: shopKey, p_campaign_id: campaignId, p_as_of: asOf.toISOString() }));

/** Records a manual review of a campaign's counts (0058). */
export const saveAdCampaignReview = (shopKey: number, campaignId: string, review: { through_day: string; outcome: "confirmed" | "corrected"; note: string }, by: string) =>
  rpc<string>("save_ad_campaign_review", { p_shop_key: shopKey, p_campaign_id: campaignId, p_review: review, p_by: by });

/** Records campaign evaluations with their policy, calc version, inputs and output, all or none (0058). */
export const recordAdCampaignEvaluations = (shopKey: number, rows: Array<{ campaign_id: string; run_id: string | null; as_of: string; policy_version: number;
  calc_version: string; action: string; inputs: unknown; output: unknown }>, by: string | null) =>
  rpc<number>("record_ad_campaign_evaluations", { p_shop_key: shopKey, p_rows: rows, p_by: by });
