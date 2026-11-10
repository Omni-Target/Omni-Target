import Stripe from "stripe";
import { auth } from "@clerk/nextjs/server";
import { startProviderPurchase } from "@/modules/credits/provider-payments";
import { getPackById } from "@/lib/credit-packs";
import { paymentProviderDisabledResponse } from "@/lib/payments/provider-flags";

export async function POST(
  request: Request
) {
  // SEC-08: direct Stripe checkout is off unless PAYMENTS_STRIPE_ENABLED=true.
  // The Stripe webhook stays active so started payments still settle.
  const disabled = paymentProviderDisabledResponse("stripe");
  if (disabled) return disabled;

  const stripe = new Stripe(
    process.env.STRIPE_SECRET_KEY!
  );

  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { packId } = await request.json();
  const pack = getPackById(packId);

  if (!pack) {
    return Response.json(
      { error: "Invalid pack" },
      { status: 400 }
    );
  }

  // Purchase intent for the current workspace, then the pending payment row.
  const started = await startProviderPurchase(userId, "stripe", pack);
  if (!started.ok) {
    return Response.json({ error: started.error }, { status: started.status });
  }

  // Create Stripe checkout session
  const session = await
    stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `Omni Target ${pack.name} Pack`,
            description: pack.description,
          },
          unit_amount: pack.price_usd * 100,
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url:
        `${process.env.NEXT_PUBLIC_APP_URL}` +
        `/dashboard?payment=success&pack=${packId}`,
      cancel_url:
        `${process.env.NEXT_PUBLIC_APP_URL}` +
        `/pricing?status=cancelled`,
      metadata: {
        clerk_user_id: userId,
        pack_id: packId,
        payment_id: started.paymentId,
      },
    });

  return Response.json({
    url: session.url
  });
}
