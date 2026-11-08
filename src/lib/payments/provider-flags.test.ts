import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, stripeConstructed, createPayment } = vi.hoisted(() => ({
  auth: vi.fn(),
  stripeConstructed: vi.fn(),
  createPayment: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/db", () => ({ createPayment }));
vi.mock("stripe", () => ({
  default: class {
    constructor(...args: unknown[]) {
      stripeConstructed(...args);
    }
  },
}));

import { paymentProviderEnabled } from "./provider-flags";
import { POST as stripeCheckout } from "@/app/api/payments/stripe/checkout/route";
import { POST as paystackInitiate } from "@/app/api/payments/paystack/initiate/route";

const post = (body: unknown) =>
  new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ userId: null });
  stripeConstructed.mockReset();
  createPayment.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("paymentProviderEnabled", () => {
  it("is off unless the flag is exactly 'true'", () => {
    expect(paymentProviderEnabled("stripe", {})).toBe(false);
    expect(paymentProviderEnabled("stripe", { PAYMENTS_STRIPE_ENABLED: "1" })).toBe(false);
    expect(paymentProviderEnabled("stripe", { PAYMENTS_STRIPE_ENABLED: "true" })).toBe(true);
    expect(paymentProviderEnabled("paystack", { PAYMENTS_STRIPE_ENABLED: "true" })).toBe(false);
    expect(paymentProviderEnabled("paystack", { PAYMENTS_PAYSTACK_ENABLED: "true" })).toBe(true);
  });
});

describe("direct-payment initiation is gated (SEC-08)", () => {
  it("Stripe checkout answers 404 when off, before auth or the Stripe SDK is touched", async () => {
    vi.stubEnv("PAYMENTS_STRIPE_ENABLED", "");
    const response = await stripeCheckout(post({ packId: "starter" }));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("payment_method_disabled");
    expect(stripeConstructed).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
  });

  it("Stripe checkout behaves as before when switched on", async () => {
    vi.stubEnv("PAYMENTS_STRIPE_ENABLED", "true");
    const response = await stripeCheckout(post({ packId: "starter" }));
    expect(response.status).toBe(401); // unauthenticated → existing auth check runs
    expect(stripeConstructed).toHaveBeenCalled();
  });

  it("Paystack initiation answers 404 when off, before auth", async () => {
    vi.stubEnv("PAYMENTS_PAYSTACK_ENABLED", "");
    const response = await paystackInitiate(post({ packId: "starter", email: "a@b.co" }));
    expect(response.status).toBe(404);
    expect(auth).not.toHaveBeenCalled();
    expect(createPayment).not.toHaveBeenCalled();
  });

  it("Paystack initiation behaves as before when switched on", async () => {
    vi.stubEnv("PAYMENTS_PAYSTACK_ENABLED", "true");
    const response = await paystackInitiate(post({ packId: "starter", email: "a@b.co" }));
    expect(response.status).toBe(401);
  });
});

describe("settlement routes are never gated", () => {
  it.each([
    "src/app/api/payments/stripe/webhook/route.ts",
    "src/app/api/payments/paystack/verify/route.ts",
    "src/app/api/shopify/billing/callback/route.ts",
  ])("%s does not depend on the provider flags", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).not.toMatch(/provider-flags|PAYMENTS_(STRIPE|PAYSTACK)_ENABLED/);
  });
});
