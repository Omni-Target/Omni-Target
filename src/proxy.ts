import {
  clerkMiddleware,
  createRouteMatcher,
  clerkClient,
} from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Map old step values to new ones
const STEP_MAP: Record<string, string> = {
  "connect-shopify": "connect-shopify",
  "connect-meta": "audit", // legacy → new
  audit: "audit",
  complete: "complete",
};

const isPublicRoute = createRouteMatcher([
  "/login(.*)",
  "/signup(.*)",
  "/forgot-password(.*)",
  "/onboarding/connect-meta", // legacy route — serves a redirect page
  // Shopify mandatory privacy / GDPR webhooks must be publicly accessible.
  // Shopify's servers POST to these endpoints with no Clerk session; any auth
  // redirect would cause a non-200 response and trigger Partner Dashboard
  // compliance failures during the 'Run' validation check.
  "/api/webhooks/privacy",
  "/api/webhooks/gdpr",
  "/api/shopify/webhook",
  // Server-to-server / self-verifying endpoints that arrive with no Clerk
  // session. These MUST bypass the auth redirect or the proxy returns a 307 to
  // /login and the caller (Stripe, Vercel Cron, Paystack) never reaches the
  // handler. Each verifies its own authenticity internally:
  //  - Stripe webhook: Stripe signature (constructEvent)
  //  - Cron: CRON_SECRET bearer token
  //  - Paystack verify: confirms the transaction with Paystack + amount match,
  //    and is idempotent (handles an expired browser session on redirect-back).
  "/api/payments/stripe/webhook",
  "/api/cron/(.*)",
  "/api/payments/paystack/verify",
]);

const isOnboardingRoute = createRouteMatcher(["/onboarding(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    const session = await auth();
    const userId = session.userId;

    if (!userId) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // Only enforce onboarding on standard page routes
    if (
      userId &&
      !request.nextUrl.pathname.startsWith("/api/") &&
      !request.nextUrl.pathname.startsWith("/_next/")
    ) {
      // Fetch the REAL user metadata from Clerk's API.
      // session.sessionClaims does NOT include publicMetadata by default,
      // so we must fetch the user directly to get the actual onboarding step.
      const client = await clerkClient();
      const user = await client.users.getUser(userId);
      const rawStep =
        (user.publicMetadata?.onboardingStep as string) || "connect-shopify";
      const currentStep = STEP_MAP[rawStep] || "connect-shopify";

      if (currentStep !== "complete") {
        const expectedRoute = `/onboarding/${currentStep}`;

        // If user is outside the onboarding flow, redirect them in
        if (!isOnboardingRoute(request)) {
          return NextResponse.redirect(new URL(expectedRoute, request.url));
        }
      } else {
        // Step is complete. If they try to access onboarding, send to dashboard
        // EXCEPT if they are explicitly visiting /onboarding/connect-shopify or /onboarding/audit
        const pathname = request.nextUrl.pathname;
        if (
          isOnboardingRoute(request) &&
          !pathname.startsWith("/onboarding/connect-shopify") &&
          !pathname.startsWith("/onboarding/audit")
        ) {
          return NextResponse.redirect(new URL("/dashboard", request.url));
        }
      }
    }
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
