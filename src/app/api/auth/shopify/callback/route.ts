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

    // Shopify data payload — store both domains
    const shopifyData = {
      shopify_store_url: myshopifyUrl,
      shopify_custom_domain: customDomain,
      shopify_access_token: accessToken,
    };

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
          onboardingStep: "audit"
        }),
      }
    );

    // Redirect to next onboarding step
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/onboarding/audit`
    );

  } catch (err) {
    console.error("Shopify OAuth error:", err);
    return Response.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/onboarding/connect-shopify?error=failed`
    );
  }
}
