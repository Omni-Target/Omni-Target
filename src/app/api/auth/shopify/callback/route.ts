import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { createHmac } from "crypto";

export async function GET(request: Request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  
  const code = searchParams.get("code");
  const shop = searchParams.get("shop");
  const state = searchParams.get("state");
  const hmac = searchParams.get("hmac");

  // Verify HMAC signature from Shopify
  const params = Object.fromEntries(
    searchParams.entries()
  );
  delete params.hmac;
  
  const message = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&");

  const computedHmac = createHmac(
    "sha256", 
    process.env.SHOPIFY_CLIENT_SECRET!
  )
    .update(message)
    .digest("hex");

  if (computedHmac !== hmac) {
    return Response.json(
      { error: "Invalid HMAC" }, 
      { status: 401 }
    );
  }

  if (!code || !shop) {
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/onboarding/connect-shopify?error=missing`
    );
  }

  try {
    // Exchange code for permanent access token
    const tokenRes = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: 
            process.env.SHOPIFY_CLIENT_SECRET,
          code,
        }),
      }
    );

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      throw new Error("No access token returned");
    }

    console.log("Shopify token exchange success. Shop:", shop);

    // Shopify data payload
    const shopifyData = {
      shopify_store_url: shop,
      shopify_access_token: accessToken,
    };

    // Check if a row already exists for this user
    const { data: existing } = await supabaseAdmin
      .from("user_integrations")
      .select("id")
      .eq("clerk_user_id", userId)
      .single();

    console.log("Existing row found:", !!existing);

    if (existing) {
      const { error: updateError } = await supabaseAdmin
        .from("user_integrations")
        .update(shopifyData)
        .eq("clerk_user_id", userId);

      console.log("Shopify update error:", updateError);
    } else {
      const { error: insertError } = await supabaseAdmin
        .from("user_integrations")
        .insert({
          clerk_user_id: userId,
          ...shopifyData,
        });

      console.log("Shopify insert error:", insertError);
    }

    // Update Clerk metadata
    await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/api/user/update-metadata`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({ 
          shopifyStoreUrl: shop,
          onboardingStep: "connect-meta"
        }),
      }
    );

    // Redirect to next onboarding step
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/onboarding/connect-meta`
    );

  } catch (err) {
    console.error("Shopify OAuth error:", err);
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/onboarding/connect-shopify?error=failed`
    );
  }
}
