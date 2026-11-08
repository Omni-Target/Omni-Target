/**
 * Direct-payment provider flags (SEC-08).
 *
 * Shopify Billing is the live payment path; the Stripe and Paystack purchase
 * options are already hidden in the UI. Their *initiation* routes
 * (stripe/checkout, paystack/initiate) are gated here and default to OFF, so
 * no new direct payment can be started unless a provider is deliberately
 * re-enabled with PAYMENTS_STRIPE_ENABLED=true / PAYMENTS_PAYSTACK_ENABLED=true.
 *
 * Settlement routes are deliberately NOT gated: the Stripe webhook and the
 * Paystack verify callback must keep crediting payments that were started
 * before a provider was switched off. Shopify Billing is unaffected.
 */
export type DirectPaymentProvider = "stripe" | "paystack";

const FLAG: Record<DirectPaymentProvider, string> = {
  stripe: "PAYMENTS_STRIPE_ENABLED",
  paystack: "PAYMENTS_PAYSTACK_ENABLED",
};

export function paymentProviderEnabled(
  provider: DirectPaymentProvider,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[FLAG[provider]] === "true";
}

/** 404 when the provider is switched off (before any provider SDK is touched), else null. */
export function paymentProviderDisabledResponse(provider: DirectPaymentProvider): Response | null {
  if (paymentProviderEnabled(provider)) return null;
  return Response.json(
    { error: "This payment method is not available.", code: "payment_method_disabled" },
    { status: 404 },
  );
}
