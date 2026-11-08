import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { upsertUserIntegration } from "@/lib/db";
import { META_OAUTH_STATE_COOKIE, META_REDIRECT_URI, isMatchingOAuthState } from "@/lib/meta-oauth";
import { fetchWithRetry } from "@/lib/http";
import type { MetaAdAccount } from "@/lib/types/meta";

/**
 * Meta (Facebook Login) OAuth callback.
 *
 * SEC-04: the account is always the authenticated Clerk session — never the
 * `state` parameter — and an authorization code is only exchanged when the
 * returned `state` matches the nonce cookie set by /api/auth/meta/connect in
 * this same browser. A crafted callback link with someone else's code is
 * rejected before any token exchange or write.
 */
function finish(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(META_OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/auth/meta",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!userId) {
    return finish(request, "/login");
  }

  // Handle user denial (no side effects, so no state check needed)
  if (searchParams.get("error")) {
    return finish(request, "/settings?meta=denied");
  }

  if (!isMatchingOAuthState(request.cookies.get(META_OAUTH_STATE_COOKIE)?.value, state)) {
    console.warn("Meta OAuth callback rejected: state mismatch");
    return finish(request, "/settings?meta=error");
  }

  if (!code) {
    return finish(request, "/settings?meta=error");
  }

  try {
    // Exchange code for access token
    const tokenUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", process.env.META_APP_ID || "");
    tokenUrl.searchParams.set("client_secret", process.env.META_APP_SECRET || "");
    tokenUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
    tokenUrl.searchParams.set("code", code);
    const tokenRes = await fetch(tokenUrl.toString());
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("Meta token exchange failed:", {
        status: tokenRes.status,
        type: tokenData?.error?.type ?? null,
        code: tokenData?.error?.code ?? null,
      });
      return finish(request, "/settings?meta=error");
    }

    const accessToken: string = tokenData.access_token;

    // Ad accounts (with pixels + status) and Pages are independent reads — both
    // only need the access token — so fetch them in parallel.
    const [adAccountsRes, pagesRes] = await Promise.all([
      fetchWithRetry(
        `https://graph.facebook.com/v19.0/` +
          `me/adaccounts?fields=id,name,` +
          `account_id,account_status,currency,` +
          `user_tasks,adspixels{id,name,code}` +
          `&access_token=${encodeURIComponent(accessToken)}`,
      ),
      fetchWithRetry(
        `https://graph.facebook.com/v19.0/` +
          `me/accounts?fields=id,name,access_token` +
          `&access_token=${encodeURIComponent(accessToken)}`,
      ),
    ]);

    const [adAccountsData, pagesData] = await Promise.all([adAccountsRes.json(), pagesRes.json()]);

    const allAccounts: MetaAdAccount[] = adAccountsData.data || [];

    // Filter to only writable accounts: active + ADVERTISE permission
    const writableAccounts = allAccounts.filter(
      (a) => a.account_status === 1 && a.user_tasks?.includes("ADVERTISE"),
    );

    // Pre-select the first writable account, fallback to any active
    const activeAccount =
      writableAccounts[0] || allAccounts.find((a) => a.account_status === 1) || allAccounts[0];

    const firstPixel = activeAccount?.adspixels?.data?.[0];

    const allPages = pagesData.data || [];
    const firstPage = allPages[0];

    // Meta data payload — store only writable accounts
    const metaData = {
      meta_access_token: accessToken,
      meta_ad_accounts: writableAccounts,
      meta_ad_account_id: activeAccount?.id || null,
      meta_selected_account_id: activeAccount?.id || null,
      meta_pixel_id: firstPixel?.id || null,
      meta_pages: allPages,
      meta_page_id: firstPage?.id || null,
      meta_page_name: firstPage?.name || null,
      meta_page_access_token: firstPage?.access_token || null,
      meta_connected_at: new Date().toISOString(),
      pixel_health: firstPixel ? "unknown" : "none",
    };

    await upsertUserIntegration(userId, metaData);

    return finish(request, "/settings?meta=connected");
  } catch (err) {
    console.error("Meta OAuth error:", err instanceof Error ? err.message : "unknown error");
    return finish(request, "/settings?meta=error");
  }
}
