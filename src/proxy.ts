import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"

// Map old step values to new ones
const STEP_MAP: Record<string, string> = {
  "connect-shopify": "connect-shopify",
  "connect-meta": "audit", // legacy → new
  "audit": "audit",
  "complete": "complete",
};

const isPublicRoute = createRouteMatcher([
  '/login(.*)',
  '/signup(.*)',
  '/forgot-password(.*)',
  '/onboarding/connect-meta', // legacy route — serves a redirect page
])

const isOnboardingRoute = createRouteMatcher([
  '/onboarding(.*)'
])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
    const session = await auth()

    const userId = session.userId
    
    // Only enforce onboarding on standard page routes
    if (userId && !request.nextUrl.pathname.startsWith('/api/') && !request.nextUrl.pathname.startsWith('/_next/')) {
      const metadata = (session.sessionClaims?.publicMetadata || session.sessionClaims?.metadata || {}) as any;
      const rawStep = (metadata.onboardingStep as string) || "connect-shopify";
      const currentStep = STEP_MAP[rawStep] || "connect-shopify";

      const currentPath = request.nextUrl.pathname;

      if (currentStep !== "complete") {
        const expectedRoute = `/onboarding/${currentStep}`;
        
        // Only enforce redirection if they are outside the onboarding flow.
        // Within /onboarding, we allow free navigation to prevent redirect loops
        // caused by stale JWT session claims after step updates.
        if (!isOnboardingRoute(request)) {
          return NextResponse.redirect(new URL(expectedRoute, request.url));
        }
      } else {
        // Step is complete. If they try to access onboarding, send to dashboard
        if (isOnboardingRoute(request)) {
          return NextResponse.redirect(new URL('/dashboard', request.url));
        }
      }
    }
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
