import { auth } from "@clerk/nextjs/server";
import type { NextResponse } from "next/server";
import { apiError } from "./response";

/**
 * Result of {@link requireUser}. Uses an explicit `ok` boolean discriminant so
 * callers get reliable type narrowing:
 *
 *   const result = await requireUser();
 *   if (!result.ok) return result.response;
 *   const { userId } = result; // string
 */
export type RequireUserResult =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

/**
 * Resolves the authenticated Clerk user for an API route handler.
 *
 * Defense-in-depth: even though `proxy.ts` redirects unauthenticated requests,
 * the Next.js docs warn that proxy matchers can silently miss Server Functions
 * and refactored routes, so every protected handler should verify auth itself.
 */
export async function requireUser(): Promise<RequireUserResult> {
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, response: apiError("Unauthorized", 401) };
  }
  return { ok: true, userId };
}
