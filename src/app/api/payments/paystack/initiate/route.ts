import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getPackById } from "@/lib/credit-packs";

export async function POST(
  request: Request
) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { packId, email } =
    await request.json();

  const pack = getPackById(packId);
  if (!pack) {
    return Response.json(
      { error: "Invalid pack" },
      { status: 400 }
    );
  }

  // Create payment record in Supabase
  const { data: payment } = await
    supabaseAdmin
      .from("payments")
      .insert({
        clerk_user_id: userId,
        provider: "paystack",
        pack: packId,
        amount_ngn: pack.price_ngn,
        currency: "NGN",
        credits_granted: pack.credits,
        unlimited_days: pack.unlimited_days,
        status: "pending",
      })
      .select()
      .single();

  // Initiate Paystack transaction
  const paystackRes = await fetch(
    "https://api.paystack.co/transaction/initialize",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env
          .PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: pack.price_ngn * 100, // kobo
        currency: "NGN",
        reference: payment?.id,
        callback_url:
          `${process.env.NEXT_PUBLIC_APP_URL}` +
          `/api/payments/paystack/verify`,
        metadata: {
          clerk_user_id: userId,
          pack_id: packId,
          payment_id: payment?.id,
        },
      }),
    }
  );

  const paystackData =
    await paystackRes.json();

  if (!paystackData.status) {
    return Response.json(
      { error: "Payment initiation failed" },
      { status: 500 }
    );
  }

  return Response.json({
    authorization_url:
      paystackData.data.authorization_url,
    reference: paystackData.data.reference,
  });
}
