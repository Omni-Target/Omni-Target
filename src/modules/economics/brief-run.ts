import "server-only";
import type { BriefEconomics } from "@/lib/brief-economics";
import { shopKeyFor } from "@/modules/ingestion/repository";
import { currentWorkspaceFor } from "@/modules/workspaces/current";
import { saveEconomicsInputs } from "./repository";
import { runAndRecordEconomics } from "./service";
import { toBriefEconomics, unavailableEconomics } from "./snapshot";

/**
 * The economics of a brief's product, run and recorded now (Phase 4, task 8). The merchant's maximum for this
 * test, when given, is saved first as the product's own test limit (null clears it). Never throws: when the
 * economics cannot be calculated the snapshot says why and carries no amounts.
 */
export async function economicsForBrief(params: {
  userId: string;
  productId: string | number | null | undefined;
  testDays?: number;
  /** undefined: leave the product's limit as it is; null: clear it; a number: set it. */
  testLimit?: number | null;
}): Promise<BriefEconomics> {
  const workspace = await currentWorkspaceFor(params.userId);
  if (!workspace || workspace.status !== "active" || !workspace.shop_domain) return unavailableEconomics("shop_not_connected");
  const shopKey = await shopKeyFor(workspace.shop_domain);
  if (shopKey === null) return unavailableEconomics("shop_not_connected");
  const productId = Number(params.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) return unavailableEconomics("product_not_identified");
  try {
    if (params.testLimit !== undefined) {
      await saveEconomicsInputs(shopKey, [params.testLimit === null
        ? { product_id: productId, key: "ad_test_limit", state: "cleared" }
        : { product_id: productId, key: "ad_test_limit", value: params.testLimit, state: "merchant_entered" }], params.userId);
    }
    const asOf = new Date();
    const { runId, policyVersion, result } = await runAndRecordEconomics({ shopKey, productIds: [productId], trigger: "brief",
      requestedBy: params.userId, testDays: params.testDays, asOf });
    const recommendation = result.recommendations.find((r) => r.product_id === productId)?.output;
    if (!recommendation) return unavailableEconomics("product_not_in_store_data");
    return toBriefEconomics(recommendation, { runId, policyVersion, computedAt: asOf.toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/none of the products exist/.test(message)) return unavailableEconomics("product_not_in_store_data");
    if (/currency is not known/.test(message)) return unavailableEconomics("currency_unknown");
    console.error("Brief economics failed", message);
    return unavailableEconomics("engine_error");
  }
}
