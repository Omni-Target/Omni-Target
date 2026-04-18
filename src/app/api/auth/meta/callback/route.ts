import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { META_REDIRECT_URI } from "@/lib/meta-oauth";

export async function GET(request: Request) {
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

  try {
    console.log("Using redirect URI:", META_REDIRECT_URI);

    // Exchange code for access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&code=${code}`
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("Token exchange failed:", 
        tokenData);
      redirect("/settings?meta=error");
    }

    const accessToken = tokenData.access_token;

    // Fetch the user's ad accounts, pixels, and status
    const adAccountsRes = await fetch(
      `https://graph.facebook.com/v19.0/` +
      `me/adaccounts?fields=id,name,` +
      `account_id,account_status,currency,adspixels{id,name,code}` +
      `&access_token=${accessToken}`
    );

    const adAccountsData = await adAccountsRes.json();
    const allAccounts = adAccountsData.data || [];

    // Store ALL accounts as JSON array
    // Pre-select the first active one
    const activeAccount = allAccounts.find(
      (a: any) => a.account_status === 1
    ) || allAccounts[0];

    const firstPixel = activeAccount?.adspixels?.data?.[0];

    const pagesRes = await fetch(
      `https://graph.facebook.com/v19.0/` +
      `me/accounts?fields=id,name,access_token` +
      `&access_token=${accessToken}`
    );

    const pagesData = await pagesRes.json();
    const allPages = pagesData.data || [];
    const firstPage = allPages[0];

    // Update Supabase with pixel and account info
    await supabaseAdmin
      .from("user_integrations")
      .upsert({
        clerk_user_id: state,
        meta_access_token: accessToken,
        meta_ad_accounts: allAccounts,
        meta_ad_account_id: activeAccount?.id || null,
        meta_selected_account_id: activeAccount?.id || null,
        meta_pixel_id: firstPixel?.id || null,
        meta_pages: allPages,
        meta_page_id: firstPage?.id || null,
        meta_page_name: firstPage?.name || null,
        meta_connected_at: new Date().toISOString(),
        // Set pixel health based on whether pixel exists
        pixel_health: firstPixel ? "unknown" : "none",
      }, {
        onConflict: "clerk_user_id"
      });

    redirect("/settings?meta=connected");

  } catch (err) {
    console.error("Meta OAuth error:", err);
    redirect("/settings?meta=error");
  }
}
