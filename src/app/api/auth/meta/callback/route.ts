import { auth } from "@clerk/nextjs/server";
import { upsertUserIntegration } from "@/lib/db";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { META_REDIRECT_URI } from "@/lib/meta-oauth";
import { fetchWithRetry } from "@/lib/http";
import type { MetaAdAccount } from "@/lib/types/meta";

export async function GET(request: Request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // Handle user denial
  if (error) {
    redirect("/settings?meta=denied");
  }

  if (!code) {
    redirect("/settings?meta=error");
  }

  // Use auth() userId first, fall back to state param
  const clerkUserId = userId || state;

  console.log("Meta callback - clerkUserId:", clerkUserId);
  console.log("Meta callback - state param:", state);

  try {
    console.log("Redirect URI being sent:", META_REDIRECT_URI);
    console.log("Encoded:", encodeURIComponent(META_REDIRECT_URI));

    // Exchange code for access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&code=${code}`
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("Token exchange failed:", tokenData);
      redirect("/settings?meta=error");
    }

    const accessToken = tokenData.access_token;
    console.log("Token exchange success. Has token:", !!accessToken);

    // Ad accounts (with pixels + status) and Pages are independent reads — both
    // only need the access token — so fetch them in parallel instead of
    // waterfalling one after the other.
    const [adAccountsRes, pagesRes] = await Promise.all([
      fetchWithRetry(
        `https://graph.facebook.com/v19.0/` +
        `me/adaccounts?fields=id,name,` +
        `account_id,account_status,currency,` +
        `user_tasks,adspixels{id,name,code}` +
        `&access_token=${accessToken}`
      ),
      fetchWithRetry(
        `https://graph.facebook.com/v19.0/` +
        `me/accounts?fields=id,name,access_token` +
        `&access_token=${accessToken}`
      ),
    ]);

    const [adAccountsData, pagesData] = await Promise.all([
      adAccountsRes.json(),
      pagesRes.json(),
    ]);

    const allAccounts: MetaAdAccount[] = adAccountsData.data || [];
    console.log("Ad accounts found (total):", allAccounts.length);

    // Filter to only writable accounts: active + ADVERTISE permission
    const writableAccounts = allAccounts.filter(
      (a) =>
          a.account_status === 1 &&
          a.user_tasks?.includes("ADVERTISE")
    );
    console.log("Writable ad accounts:", writableAccounts.length);

    // Pre-select the first writable account, fallback to any active
    const activeAccount = writableAccounts[0] ||
      allAccounts.find((a) => a.account_status === 1) ||
      allAccounts[0];

    const firstPixel = activeAccount?.adspixels?.data?.[0];

    const allPages = pagesData.data || [];
    const firstPage = allPages[0];
    console.log("Pages found:", allPages.length);

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

    console.log("Upserting Meta integration details for Clerk user:", clerkUserId);
    await upsertUserIntegration(clerkUserId!, metaData);

    redirect("/settings?meta=connected");

  } catch (err) {
    // Re-throw Next.js redirect errors so they are handled correctly
    if (isRedirectError(err)) {
      throw err;
    }
    console.error("Meta OAuth error:", err);
    redirect("/settings?meta=error");
  }
}
