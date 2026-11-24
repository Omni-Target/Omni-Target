import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import { parseEconomicsPolicy, type EconomicsPolicy } from "./policy";
import type { MerchantInputKey, StoredMerchantInputs } from "./inputs";
import { normaliseEvidence, type EconomicsEvidence } from "./evidence";

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
  | { product_id?: number; key: MerchantInputKey; value: number; state: "merchant_entered" | "confirmed_none" | "merchant_estimate" }
  | { product_id?: number; key: MerchantInputKey; state: "cleared" };

/** Saves or clears inputs, all or none; the database checks each against the catalogue. */
export const saveEconomicsInputs = (shopKey: number, changes: MerchantInputChange[], enteredBy: string) =>
  rpc<{ saved: number; cleared: number }>("save_economics_inputs", { p_shop_key: shopKey, p_inputs: changes, p_entered_by: enteredBy });

/** The economics evidence for at most 200 products, over the windows the policy sets (migration 0053). */
export async function productEconomicsEvidence(shopKey: number, productIds: number[], asOf: Date, policy: EconomicsPolicy): Promise<EconomicsEvidence> {
  const s = policy.settings;
  const raw = await rpc<EconomicsEvidence>("product_economics_evidence", {
    p_shop_key: shopKey, p_product_ids: productIds.slice(0, 200), p_as_of: asOf.toISOString(),
    p_sales_window_days: s.sales_window_days, p_discount_window_days: s.discount_window_days,
    p_maturity_days: s.return_maturity_days, p_demand_window_days: s.established_demand_window_days,
  });
  return normaliseEvidence(raw);
}
