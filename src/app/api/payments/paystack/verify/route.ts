import { getPaymentById } from "@/lib/db";
import { getPackById } from "@/lib/credit-packs";
import { settleProviderPayment } from "@/modules/credits/provider-payments";
import { getEnv, requireEnv } from "@/lib/env";

export async function GET(request: Request) {
  const appUrl = getEnv().NEXT_PUBLIC_APP_URL;
  const { searchParams } = new URL(request.url);
  const reference = searchParams.get("reference");

  if (!reference) {
    return Response.redirect(`${appUrl}/pricing?status=failed`);
  }

  try {
    // Verify the transaction with Paystack.
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${requireEnv("PAYSTACK_SECRET_KEY")}`,
        },
      }
    );

    const verifyData = await verifyRes.json();

    if (verifyData?.data?.status !== "success") {
      return Response.redirect(`${appUrl}/pricing?status=failed`);
    }

    // Source identity + pack from OUR records (reference === our payment id),
    // never from Paystack metadata, so they can't be spoofed.
    const payment = await getPaymentById(reference);
    if (!payment) {
      console.error("[paystack-verify] no payment record for reference", reference);
      return Response.redirect(`${appUrl}/pricing?status=failed`);
    }

    const pack = getPackById(payment.pack);
    if (!pack) {
      console.error("[paystack-verify] unknown pack on payment", payment.id);
      return Response.redirect(`${appUrl}/pricing?status=failed`);
    }

    // Validate the amount actually paid matches the pack price (in kobo).
    const expected = pack.price_ngn * 100;
    if (
      verifyData.data.amount !== expected ||
      (verifyData.data.currency && verifyData.data.currency !== "NGN")
    ) {
      console.error(
        `[paystack-verify] amount mismatch for payment ${payment.id}: paid ${verifyData.data.amount} ${verifyData.data.currency}, expected ${expected} NGN`
      );
      return Response.redirect(`${appUrl}/pricing?status=failed`);
    }

    // Credited to the purchase intent's workspace; idempotent against replays.
    const outcome = await settleProviderPayment("paystack", payment.id, pack, reference);
    if (outcome !== "granted" && outcome !== "duplicate") {
      return Response.redirect(`${appUrl}/pricing?status=failed`);
    }

    return Response.redirect(
      `${appUrl}/dashboard?payment=success&pack=${pack.id}`
    );
  } catch (error) {
    console.error("[paystack-verify] error", error);
    return Response.redirect(`${appUrl}/pricing?status=failed`);
  }
}
