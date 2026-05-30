import Stripe from "stripe";
import { auth } from "@clerk/nextjs/server";
import { createPayment } from "@/lib/db";
import { getPackById } from "@/lib/credit-packs";

export async function POST(
  request: Request
) {
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

  // Create payment record
  const payment = await createPayment({
    clerk_user_id: userId,
    provider: "stripe",
    pack: packId,
    amount_usd: pack.price_usd,
    currency: "USD",
    credits_granted: pack.credits,
    unlimited_days: pack.unlimited_days,
    status: "pending",
  });

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
        payment_id: payment?.id || "",
      },
    });

  return Response.json({
    url: session.url
  });
}
