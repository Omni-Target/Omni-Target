import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { startProviderPurchase } from "@/modules/credits/provider-payments";
import { getPackById } from "@/lib/credit-packs";
import { paymentProviderDisabledResponse } from "@/lib/payments/provider-flags";

const BodySchema = z.object({
  packId: z.string().min(1).max(100),
  email: z.string().email(),
});

export async function POST(request: Request) {
  // SEC-08: Paystack initiation is off unless PAYMENTS_PAYSTACK_ENABLED=true.
  // The verify callback stays active so started payments still settle.
  const disabled = paymentProviderDisabledResponse("paystack");
  if (disabled) return disabled;

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

  let paymentId: string;
  try {
    // Purchase intent for the current workspace, then the pending payment row.
    const started = await startProviderPurchase(userId, "paystack", pack);
    if (!started.ok) {
      return Response.json({ error: started.error }, { status: started.status });
    }
    paymentId = started.paymentId;
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
        reference: paymentId,
        callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/payments/paystack/verify`,
        metadata: {
          clerk_user_id: userId,
          pack_id: packId,
          payment_id: paymentId,
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
