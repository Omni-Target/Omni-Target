import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { redirect } from "next/navigation";

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
    // Exchange code for access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&redirect_uri=${process.env.NEXT_PUBLIC_APP_URL}/api/auth/meta/callback&code=${code}`
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("Token exchange failed:", 
        tokenData);
      redirect("/settings?meta=error");
    }

    const accessToken = tokenData.access_token;

    // Fetch the user's ad accounts
    const adAccountsRes = await fetch(
      `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id&access_token=${accessToken}`
    );

    const adAccountsData = 
      await adAccountsRes.json();
    
    const firstAdAccount = 
      adAccountsData.data?.[0];

    // Store in Supabase
    // state = clerk_user_id passed earlier
    await supabaseAdmin
      .from("user_integrations")
      .upsert({
        clerk_user_id: state,
        meta_access_token: accessToken,
        meta_ad_account_id: 
          firstAdAccount?.id || null,
        meta_business_id: 
          firstAdAccount?.account_id || null,
        meta_connected_at: new Date()
          .toISOString(),
      }, {
        onConflict: "clerk_user_id"
      });

    redirect("/settings?meta=connected");

  } catch (err) {
    console.error("Meta OAuth error:", err);
    redirect("/settings?meta=error");
  }
}
