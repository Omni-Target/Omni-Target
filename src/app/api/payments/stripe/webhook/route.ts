import Stripe from "stripe";
import { getPackById } from "@/lib/credit-packs";
import { settleProviderPayment } from "@/modules/credits/provider-payments";
import { requireEnv } from "@/lib/env";

export async function POST(request: Request) {
  const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"));

  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    return Response.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      requireEnv("STRIPE_WEBHOOK_SECRET")
    );
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    // Who is credited comes from the purchase intent keyed by payment_id, not
    // from session metadata.
    const { pack_id, payment_id } = session.metadata ?? {};

    if (!pack_id || !payment_id) {
      console.error("[stripe-webhook] missing metadata on session", session.id);
      return Response.json({ received: true });
    }

    const pack = getPackById(pack_id);
    if (!pack) {
      console.error("[stripe-webhook] unknown pack", pack_id);
      return Response.json({ received: true });
    }

    // Validate the amount actually paid matches the pack price (the event is
    // Stripe-signed, so this catches config drift / tampered sessions).
    const expected = pack.price_usd * 100;
    if (
      session.amount_total !== expected ||
      (session.currency && session.currency !== "usd")
    ) {
      console.error(
        `[stripe-webhook] amount mismatch for payment ${payment_id}: paid ${session.amount_total} ${session.currency}, expected ${expected} usd`
      );
      return Response.json({ received: true });
    }

    try {
      // Credited to the intent's workspace; the payment row settles in the same
      // transaction. Idempotent, so Stripe's retries are safe.
      await settleProviderPayment("stripe", payment_id, pack, (session.payment_intent as string | null) ?? null);
    } catch (err) {
      console.error("[stripe-webhook] settlement failed", err);
      return Response.json({ error: "Processing failed" }, { status: 500 });
    }
  }

  return Response.json({ received: true });
}
