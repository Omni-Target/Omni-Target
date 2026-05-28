import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { createHmac } from "crypto";

export async function GET(request: Request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  
  const code = searchParams.get("code");
  const shop = searchParams.get("shop");
  const state = searchParams.get("state") || "";
  const hmac = searchParams.get("hmac");

  const [_, from] = state.split("___");
  const isFromDashboard = from === "dashboard";

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
    // Exchange code for an EXPIRING offline access token.
    // The key parameter is "expiring": 1 — this tells Shopify
    // to return an expiring token + refresh token instead of the
    // now-deprecated non-expiring token.
    const tokenRes = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          code,
          expiring: 1,
        }),
      }
    );

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = tokenData.expires_in || null; // seconds

    if (!accessToken) {
      console.error("Token exchange failed:", tokenData);
      throw new Error("No access token returned");
    }

    console.log("Shopify token exchange success. Shop:", shop);
    console.log("Token type:", refreshToken ? "expiring" : "non-expiring");
    if (expiresIn) console.log("Expires in:", expiresIn, "seconds");

    // Calculate token expiration timestamp
    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    // Fetch shop details to get the primary custom domain
    const shopDetailsRes = await fetch(
      `https://${shop}/admin/api/2026-01/shop.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken
        }
      }
    );

    const shopDetails = await shopDetailsRes.json();
    const customDomain = shopDetails.shop?.domain || null;
    const myshopifyUrl = shopDetails.shop?.myshopify_domain || shop;

    console.log("Shopify custom domain:", customDomain);
    console.log("Shopify myshopify URL:", myshopifyUrl);

    // Shopify data payload — store token + refresh token + expiry
    const shopifyData: Record<string, any> = {
      shopify_store_url: myshopifyUrl,
      shopify_custom_domain: customDomain,
      shopify_access_token: accessToken,
      shop_domain: myshopifyUrl, // explicitly set shop_domain
      access_token: accessToken, // explicitly set access_token
      shopify_refresh_token: refreshToken,
      shopify_token_expires_at: tokenExpiresAt,
    };

    // Populate new schema columns if they exist (backward compatibility / redundancy check)
    const { detectColumns, handleFreeCreditOnInstall } = await import("@/lib/billing-db");
    const cols = await detectColumns();
    if (cols.hasShopDomain) {
      shopifyData.shop_domain = myshopifyUrl;
    }
    if (cols.hasAccessToken) {
      shopifyData.access_token = accessToken;
    }

    const { data: existingByStore } = await 
      supabaseAdmin
        .from("user_integrations")
        .select("clerk_user_id")
        .eq("shopify_store_url", shop)
        .neq("clerk_user_id", userId!)
        .single();

    if (existingByStore) {
      console.warn(
        "Store already connected to different user:", 
        existingByStore.clerk_user_id
      );
      // Merge the data to the current user
      // by copying shopify credentials
    }

    // Upsert the integration row matched by the current Clerk user ID
    console.log("Upserting user integration for Clerk user:", userId);
    const { error: upsertError } = await supabaseAdmin
      .from("user_integrations")
      .upsert({
        clerk_user_id: userId,
        ...shopifyData,
      }, {
        onConflict: "clerk_user_id"
      });

    if (upsertError) {
      console.error("Shopify upsert error:", upsertError);
      throw upsertError;
    }

    console.log("Shopify upsert success");

    // Give 1 free credit on install if free_credit_used is false
    await handleFreeCreditOnInstall(userId!);

    // Register the orders/paid webhook so confirmed purchases
    // are forwarded to Meta CAPI for attribution
    const webhookUrl =
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/api/shopify/webhook`;

    const webhookRes = await fetch(
      `https://${shop}/admin/api/2026-01/webhooks.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          webhook: {
            topic: "orders/paid",
            address: webhookUrl,
            format: "json",
          },
        }),
      }
    );

    const webhookData = await webhookRes.json();

    console.log("Webhook registration:", {
      success: !!webhookData.webhook?.id,
      webhookId: webhookData.webhook?.id,
      error: webhookData.errors || null,
    });

    // Store the webhook ID so we can delete it if the user disconnects
    if (webhookData.webhook?.id) {
      await supabaseAdmin
        .from("user_integrations")
        .update({
          shopify_webhook_id: String(webhookData.webhook.id),
        })
        .eq("clerk_user_id", userId);
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
          onboardingStep: isFromDashboard ? "complete" : "audit"
        }),
      }
    );

    // Redirect to next onboarding step
    const redirectUrl = isFromDashboard
      ? `${process.env.NEXT_PUBLIC_APP_URL}/onboarding/audit?from=dashboard`
      : `${process.env.NEXT_PUBLIC_APP_URL}/onboarding/audit`;

    return Response.redirect(redirectUrl);

  } catch (err) {
    console.error("Shopify OAuth error:", err);
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/onboarding/connect-shopify?error=failed`
    );
  }
}
