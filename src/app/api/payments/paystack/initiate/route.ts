import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { createPayment } from "@/lib/db";
import { getPackById } from "@/lib/credit-packs";

const BodySchema = z.object({
  packId: z.string().min(1).max(100),
  email: z.string().email(),
});

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const { packId, email } = parsed.data;

  const pack = getPackById(packId);
  if (!pack) {
    return Response.json(
      { error: "Invalid pack" },
      { status: 400 }
    );
  }

  let payment;
  try {
    // Create pending payment record
    payment = await createPayment({
      clerk_user_id: userId,
      provider: "paystack",
      pack: packId,
      amount_ngn: pack.price_ngn,
      currency: "NGN",
      credits_granted: pack.credits,
      unlimited_days: pack.unlimited_days,
      status: "pending",
    });
  } catch (error) {
    console.error("Payment insert error:", error);
    return Response.json(
      { error: "Failed to create payment" },
      { status: 500 }
    );
  }

  // Initiate Paystack transaction
  const paystackRes = await fetch(
    "https://api.paystack.co/transaction/initialize",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: pack.price_ngn * 100,
        currency: "NGN",
        reference: payment.id,
        callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/payments/paystack/verify`,
        metadata: {
          clerk_user_id: userId,
          pack_id: packId,
          payment_id: payment.id,
          pack_name: pack.name,
        },
      }),
    }
  );

  const paystackData = await paystackRes.json();

  if (!paystackData.status) {
    console.error("Paystack error:", paystackData);
    return Response.json(
      { error: "Payment initiation failed" },
      { status: 500 }
    );
  }

  return Response.json({
    authorization_url: paystackData.data.authorization_url,
    reference: paystackData.data.reference,
  });
}
