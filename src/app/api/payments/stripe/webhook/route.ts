import Stripe from "stripe";
import { getPackById } from "@/lib/credit-packs";
import { grantCredits } from "@/lib/grant-credits";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || ""
);

export async function POST(
  request: Request
) {
  const body = await request.text();
  const sig = request.headers
    .get("stripe-signature")!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch {
    return Response.json(
      { error: "Invalid signature" },
      { status: 400 }
    );
  }

  if (event.type ===
      "checkout.session.completed") {
    const session =
      event.data.object as
      Stripe.Checkout.Session;

    const {
      clerk_user_id,
      pack_id,
      payment_id
    } = session.metadata!;

    const pack = getPackById(pack_id);
    if (pack) {
      await grantCredits(
        clerk_user_id,
        pack,
        payment_id,
        session.payment_intent as string
      );
    }
  }

  return Response.json({ received: true });
}
