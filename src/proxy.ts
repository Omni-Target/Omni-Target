import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"

const isPublicRoute = createRouteMatcher([
  '/login(.*)',
  '/signup(.*)',
  '/forgot-password(.*)'
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
      let step = metadata.onboardingStep || "connect-shopify";

      // If user's step is "connect-meta" (old data), treat it as "audit"
      if (step === "connect-meta") {
        step = "audit";
      }

      const currentPath = request.nextUrl.pathname;

      if (step !== "complete") {
        const expectedRoute = `/onboarding/${step}`;
        
        // If not on expected route, redirect
        if (currentPath !== expectedRoute) {
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
