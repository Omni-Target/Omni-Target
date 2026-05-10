import { supabaseAdmin } from "./supabase";
import { CreditPack } from "./credit-packs";

export async function grantCredits(
  userId: string,
  pack: CreditPack,
  paymentId: string,
  providerReference: string
) {
  // Update payment status
  await supabaseAdmin
    .from("payments")
    .update({
      status: "success",
      provider_reference: providerReference,
    })
    .eq("id", paymentId);

  if (pack.unlimited_days > 0) {
    // Agency pack — set unlimited expiry
    const expiresAt = new Date();
    expiresAt.setDate(
      expiresAt.getDate() + pack.unlimited_days
    );

    await supabaseAdmin
      .from("user_integrations")
      .update({
        credits_unlimited_until:
          expiresAt.toISOString(),
      })
      .eq("clerk_user_id", userId);
  } else {
    // Credit pack — add credits
    const { data: current } = await
      supabaseAdmin
        .from("user_integrations")
        .select(
          "credits_balance, " +
          "credits_total_purchased"
        )
        .eq("clerk_user_id", userId)
        .single() as { data: { credits_balance: number; credits_total_purchased: number } | null };

    await supabaseAdmin
      .from("user_integrations")
      .update({
        credits_balance:
          (current?.credits_balance || 0) +
          pack.credits,
        credits_total_purchased:
          (current?.credits_total_purchased
            || 0) + pack.credits,
      })
      .eq("clerk_user_id", userId);
  }

  console.log(
    `Credits granted: ${pack.credits} credits to ${userId}`
  );
}
