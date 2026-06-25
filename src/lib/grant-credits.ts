import { getUserIntegration, updateUserIntegration, updatePayment } from "./db";
import { CreditPack } from "./credit-packs";

export async function grantCredits(
  userId: string,
  pack: CreditPack,
  paymentId: string,
  providerReference: string
) {
  // Update payment status
  await updatePayment(paymentId, {
    status: "success",
    provider_reference: providerReference,
  });

  if (pack.unlimited_days > 0) {
    // Agency pack — set unlimited expiry
    const expiresAt = new Date();
    expiresAt.setDate(
      expiresAt.getDate() + pack.unlimited_days
    );

    await updateUserIntegration(userId, {
      credits_unlimited_until: expiresAt.toISOString(),
    });
  } else {
    // Credit pack — add credits
    const current = await getUserIntegration(userId);

    await updateUserIntegration(userId, {
      credits_balance: (current?.credits_balance || 0) + pack.credits,
      credits_total_purchased: (current?.credits_total_purchased || 0) + pack.credits,
    });
  }

  console.log(
    `Credits granted: ${pack.credits} credits to ${userId}`
  );
}
