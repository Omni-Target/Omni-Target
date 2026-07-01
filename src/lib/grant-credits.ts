import {
  updateUserIntegration,
  updatePayment,
  claimPayment,
  releasePayment,
  incrementCredits,
} from "./db";
import { CreditPack } from "./credit-packs";

/**
 * Grant the credits for a completed payment.
 *
 * Idempotent and concurrency-safe:
 *  - `claimPayment` atomically ensures a given payment grants credits at most
 *    once, even across duplicate/retried webhook deliveries.
 *  - credits are added via the atomic `increment_credits` RPC (no lost updates).
 *  - if anything fails after the claim, the claim is released so a retry can
 *    re-process the payment instead of it being silently dropped.
 */
export async function grantCredits(
  userId: string,
  pack: CreditPack,
  paymentId: string,
  providerReference: string
) {
  const claimed = await claimPayment(paymentId);
  if (!claimed) {
    console.log(
      `[grantCredits] payment ${paymentId} already processed — skipping`
    );
    return;
  }

  try {
    // Update payment status
    await updatePayment(paymentId, {
      status: "success",
      provider_reference: providerReference,
    });

    if (pack.unlimited_days > 0) {
      // Agency pack — set unlimited expiry
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + pack.unlimited_days);

      await updateUserIntegration(userId, {
        credits_unlimited_until: expiresAt.toISOString(),
      });
    } else {
      // Credit pack — atomically add credits
      await incrementCredits(userId, pack.credits, pack.credits);
    }

    console.log(
      `[grantCredits] granted ${pack.credits} credits to ${userId} (payment ${paymentId})`
    );
  } catch (error) {
    // Release the claim so the provider's retry can re-process this payment.
    await releasePayment(paymentId).catch(() => {});
    throw error;
  }
}
