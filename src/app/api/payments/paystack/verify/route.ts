import { supabaseAdmin } from "@/lib/supabase";
import { getPackById } from "@/lib/credit-packs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const reference = searchParams.get("reference");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!reference) {
    return Response.redirect(`${appUrl}/pricing?status=failed`);
  }

  try {
    // Verify with Paystack
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const verifyData = await verifyRes.json();

    console.log("Paystack verify:", {
      status: verifyData.data?.status,
      reference,
      amount: verifyData.data?.amount,
    });

    if (verifyData.data?.status !== "success") {
      return Response.redirect(`${appUrl}/pricing?status=failed`);
    }

    const metadata = verifyData.data.metadata;
    const { clerk_user_id, pack_id, payment_id } = metadata;

    const pack = getPackById(pack_id);
    if (!pack) {
      return Response.redirect(`${appUrl}/pricing?status=failed`);
    }

    // Update payment status
    await supabaseAdmin
      .from("payments")
      .update({
        status: "success",
        provider_reference: reference,
      })
      .eq("id", payment_id);

    // Grant credits
    if (pack.unlimited_days > 0) {
      // Agency pack
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + pack.unlimited_days);

      await supabaseAdmin
        .from("user_integrations")
        .update({
          credits_unlimited_until: expiresAt.toISOString(),
        })
        .eq("clerk_user_id", clerk_user_id);
    } else {
      // Launch or Growth pack
      const { data: current } = await supabaseAdmin
        .from("user_integrations")
        .select("credits_balance, credits_total_purchased")
        .eq("clerk_user_id", clerk_user_id)
        .single();

      await supabaseAdmin
        .from("user_integrations")
        .update({
          credits_balance: (current?.credits_balance || 0) + pack.credits,
          credits_total_purchased: (current?.credits_total_purchased || 0) + pack.credits,
        })
        .eq("clerk_user_id", clerk_user_id);
    }

    console.log(`Credits granted: ${pack.credits} to ${clerk_user_id}`);

    return Response.redirect(`${appUrl}/dashboard?payment=success&pack=${pack_id}`);

  } catch (error) {
    console.error("Verify error:", error);
    return Response.redirect(`${appUrl}/pricing?status=failed`);
  }
}
