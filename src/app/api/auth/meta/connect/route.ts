import { randomBytes } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { META_OAUTH_STATE_COOKIE, META_REDIRECT_URI } from "@/lib/meta-oauth";

/**
 * Starts Meta (Facebook Login) OAuth for the signed-in user.
 *
 * SEC-04: `state` is an unguessable nonce also stored in an httpOnly cookie
 * scoped to /api/auth/meta. The callback only exchanges a code when the
 * returned state matches this browser's cookie, so a crafted callback link
 * carrying someone else's authorization code cannot link their Meta account
 * (and pixel) to the victim's Omnitarget account.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nonce = randomBytes(32).toString("hex");
  const scope = ["ads_management", "ads_read", "business_management", "pages_read_engagement"].join(",");

  const authorize = new URL("https://www.facebook.com/v19.0/dialog/oauth");
  authorize.searchParams.set("client_id", process.env.META_APP_ID || "");
  authorize.searchParams.set("redirect_uri", META_REDIRECT_URI);
  authorize.searchParams.set("scope", scope);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", nonce);

  const response = NextResponse.redirect(authorize.toString());
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(META_OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/auth/meta",
    maxAge: 10 * 60,
  });
  return response;
}
