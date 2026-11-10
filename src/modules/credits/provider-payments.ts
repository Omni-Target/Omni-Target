import "server-only";
import { randomUUID } from "node:crypto";
import { createPayment } from "@/lib/db";
import type { CreditPack } from "@/lib/credit-packs";
import { currentWorkspaceFor } from "@/modules/workspaces/current";
import { createLogger } from "@/platform/logger";
import { createPurchaseIntent, grantIntentPurchase, type PurchaseOutcome } from "./ledger";

/**
 * Stripe and Paystack credit packs (Phase 1, task 5). Both are disabled by
 * default (SEC-08) but their settlement endpoints stay live. A purchase starts
 * with an intent for the purchaser's current workspace, keyed by our payments
 * row id; settlement credits that intent's workspace in the same transaction
 * that marks the payment successful. Provider metadata never decides who is
 * credited.
 */

const log = createLogger({ module: "provider-payments" });

export type CardProvider = "stripe" | "paystack";

export type StartResult = { ok: true; paymentId: string } | { ok: false; status: number; error: string };

export async function startProviderPurchase(userId: string, provider: CardProvider, pack: CreditPack): Promise<StartResult> {
  const workspace = await currentWorkspaceFor(userId);
  if (!workspace || workspace.status !== "active") {
    return { ok: false, status: 409, error: "Connect your store before buying credits." };
  }
  const paymentId = randomUUID();
  const amount = provider === "stripe" ? pack.price_usd : pack.price_ngn;
  const currency = provider === "stripe" ? "USD" : "NGN";
  await createPurchaseIntent({
    workspaceId: workspace.workspace_id,
    actor: userId,
    provider,
    planKey: pack.id,
    kind: "one_time",
    credits: pack.credits,
    unlimitedDays: pack.unlimited_days,
    amount,
    currency,
    externalChargeId: paymentId,
  });
  await createPayment({
    id: paymentId,
    clerk_user_id: userId,
    provider,
    pack: pack.id,
    ...(provider === "stripe" ? { amount_usd: amount } : { amount_ngn: amount }),
    currency,
    credits_granted: pack.credits,
    unlimited_days: pack.unlimited_days,
    status: "pending",
  });
  return { ok: true, paymentId };
}

/**
 * Settles a provider-confirmed payment. The caller has already verified the
 * provider's signature or API response and the amount paid. Idempotent: a
 * repeated delivery returns "duplicate".
 */
export async function settleProviderPayment(
  provider: CardProvider,
  paymentId: string,
  pack: CreditPack,
  providerReference: string | null,
): Promise<PurchaseOutcome> {
  const result = await grantIntentPurchase({
    provider,
    externalId: paymentId,
    planKey: pack.id,
    providerStatus: "paid",
    test: false,
    creditable: true,
    amount: provider === "stripe" ? pack.price_usd : pack.price_ngn,
    currency: provider === "stripe" ? "USD" : "NGN",
    providerCreatedAt: null,
    details: providerReference ? { provider_reference: providerReference } : {},
  });
  if (result.outcome === "no_intent") {
    // Started before purchase intents existed: never credited by guesswork.
    log.error("Provider payment has no purchase intent; left for review", { provider, paymentId });
  } else if (result.outcome !== "granted" && result.outcome !== "duplicate") {
    log.warn("Provider payment not credited", { provider, paymentId, outcome: result.outcome });
  }
  return result.outcome;
}
