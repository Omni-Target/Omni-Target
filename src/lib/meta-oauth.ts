import { timingSafeEqual } from "node:crypto";

export const META_REDIRECT_URI =
  `${(process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "")}` +
  `/api/auth/meta/callback`;

/** httpOnly cookie (scoped to /api/auth/meta) holding the OAuth `state` nonce. */
export const META_OAUTH_STATE_COOKIE = "meta_oauth_state";

/**
 * Constant-time check that the `state` Meta returned equals the nonce this
 * browser received when the flow started (SEC-04 CSRF protection).
 */
export function isMatchingOAuthState(expected: string | null | undefined, received: string | null | undefined): boolean {
  if (!expected || !received) return false;
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
