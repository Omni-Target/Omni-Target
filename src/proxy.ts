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
  // Allow storefront domain verification for unauthenticated merchants
  "/api/shopify/resolve-domain",
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
  // Shopify App Store install, login with Shopify, and SSO ticket consumption
  "/api/auth/shopify/(.*)",
  "/auth/shopify-callback(.*)",
]);

const isOnboardingRoute = createRouteMatcher(["/onboarding(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  const nextUrl = request.nextUrl;
  const planParam = nextUrl.searchParams.get("plan")?.toLowerCase();
  const validPlans = ["free", "starter", "growth", "scale"];
  const hasValidPlan = planParam && validPlans.includes(planParam);

  // Direct Shopify App Store installation entrypoint:
  // When a merchant clicks "Install" on the Shopify App Store listing, Shopify directs them to:
  //   https://app.omnitarget.co/?shop={shop}&timestamp={timestamp}&hmac={hmac}
  // Intercept this immediately and initiate the OAuth installation flow instead of bouncing to login!
  if (
    nextUrl.searchParams.has("shop") &&
    !nextUrl.pathname.startsWith("/api/auth/shopify")
  ) {
    const connectUrl = new URL("/api/auth/shopify/connect", request.url);
    nextUrl.searchParams.forEach((val, key) => {
      connectUrl.searchParams.set(key, val);
    });
    if (!connectUrl.searchParams.has("from")) {
      connectUrl.searchParams.set("from", "app_store");
    }
    const res = NextResponse.redirect(connectUrl);
    if (hasValidPlan) {
      res.cookies.set("selected_plan", planParam, { path: "/", maxAge: 3600, sameSite: "lax" });
    }
    return res;
  }

  // If unauthenticated merchant arrives on /login with a selected plan from marketing,
  // route them to /signup so they enter the signup / connect-store flow rather than "Welcome back".
  if (nextUrl.pathname.startsWith("/login") && hasValidPlan) {
    const signupUrl = new URL("/signup", request.url);
    nextUrl.searchParams.forEach((val, key) => {
      signupUrl.searchParams.set(key, val);
    });
    const res = NextResponse.redirect(signupUrl);
    res.cookies.set("selected_plan", planParam, { path: "/", maxAge: 3600, sameSite: "lax" });
    return res;
  }

  // If arriving on /signup with a plan query parameter, ensure cookie is set
  if (nextUrl.pathname.startsWith("/signup") && hasValidPlan) {
    const res = NextResponse.next();
    res.cookies.set("selected_plan", planParam, { path: "/", maxAge: 3600, sameSite: "lax" });
    return res;
  }

  if (!isPublicRoute(request)) {
    const session = await auth();
    const userId = session.userId;

    if (!userId) {
      // If unauthenticated hits root "/" (e.g. from "Scan Your Store Free" CTA),
      // route to /signup preserving query params, not /login with "Welcome back"!
      if (nextUrl.pathname === "/") {
        const signupUrl = new URL("/signup", request.url);
        nextUrl.searchParams.forEach((val, key) => {
          signupUrl.searchParams.set(key, val);
        });
        const res = NextResponse.redirect(signupUrl);
        if (hasValidPlan) {
          res.cookies.set("selected_plan", planParam, { path: "/", maxAge: 3600, sameSite: "lax" });
        }
        return res;
      }

      // Preserve query params on login redirect for protected routes
      const loginUrl = new URL("/login", request.url);
      nextUrl.searchParams.forEach((val, key) => {
        loginUrl.searchParams.set(key, val);
      });
      const res = NextResponse.redirect(loginUrl);
      if (hasValidPlan) {
        res.cookies.set("selected_plan", planParam, { path: "/", maxAge: 3600, sameSite: "lax" });
      }
      return res;
    }

    // Only enforce onboarding on standard page routes
    if (
      userId &&
      !request.nextUrl.pathname.startsWith("/api/") &&
      !request.nextUrl.pathname.startsWith("/_next/")
    ) {
      // Prefer the onboarding step from the session-token claims — that's a
      // pure JWT read, no network call. This requires a Clerk session-token
      // custom claim mapping `user.public_metadata.onboardingStep` (Clerk
      // Dashboard → Sessions → customize session token), added as either a flat
      // `onboardingStep` claim or a `metadata` object. Until that claim lands we
      // fall back to a `getUser()` API call (the original behaviour), so this is
      // safe to ship before the dashboard change and drops the per-navigation
      // Clerk round-trip once the claim is present.
      const claims = session.sessionClaims as
        | {
            onboardingStep?: string;
            shopifyStoreUrl?: string;
            metadata?: { onboardingStep?: string; shopifyStoreUrl?: string };
          }
        | undefined;
      let rawStep = claims?.onboardingStep ?? claims?.metadata?.onboardingStep;
      let shopifyStoreUrl =
        claims?.shopifyStoreUrl ?? claims?.metadata?.shopifyStoreUrl;

      // If the JWT claim does not say 'complete', verify with fresh user metadata
      // so a merchant who just finished onboarding is never bounced back by a stale JWT.
      if (!rawStep || rawStep !== "complete") {
        const client = await clerkClient();
        const user = await client.users.getUser(userId);
        const metadata = user.publicMetadata as {
          onboardingStep?: string;
          shopifyStoreUrl?: string;
        };
        rawStep = metadata?.onboardingStep;
        shopifyStoreUrl = metadata?.shopifyStoreUrl;
      }

      // If merchant has already connected their Shopify store, the connect-shopify step
      // is already satisfied! Resolve step to "audit" (or "complete"), never "connect-shopify".
      let resolvedStep = rawStep;
      if (!resolvedStep && shopifyStoreUrl) {
        resolvedStep = "audit";
      }

      const currentStep = STEP_MAP[resolvedStep || "connect-shopify"] || "connect-shopify";
      const pathname = request.nextUrl.pathname;
      const fromParam = request.nextUrl.searchParams.get("from");
      const isExplicitSettingsAction = fromParam === "dashboard" || fromParam === "pricing";

      if (currentStep !== "complete") {
        // If the merchant already has Shopify connected, they must NEVER be forced or allowed
        // into /onboarding/connect-shopify unless explicitly reconnecting from Settings or Pricing.
        if (
          pathname.startsWith("/onboarding/connect-shopify") &&
          shopifyStoreUrl &&
          !isExplicitSettingsAction
        ) {
          return NextResponse.redirect(new URL("/onboarding/audit", request.url));
        }

        const expectedRoute = `/onboarding/${currentStep}`;

        // If user is outside the onboarding flow, redirect them in
        if (!isOnboardingRoute(request)) {
          return NextResponse.redirect(new URL(expectedRoute, request.url));
        }
      } else {
        // Step is complete. If they try to access onboarding, send to dashboard
        // EXCEPT if they explicitly came from settings or pricing to connect a different store.
        if (isOnboardingRoute(request) && !isExplicitSettingsAction) {
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
