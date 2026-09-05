import { auth } from "@clerk/nextjs/server";
import { getExistingIntegrationByStore, upsertUserIntegration, updateUserIntegration } from "@/lib/db";
import { createHmac } from "crypto";

export async function GET(request: Request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  
  const code = searchParams.get("code");
  const shop = searchParams.get("shop");
  const state = searchParams.get("state") || "";
  const hmac = searchParams.get("hmac");

  const [, from] = state.split("___");
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
    const [, fromParam] = state.split("___");
    const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, "");
    if (fromParam === "login") {
      return Response.redirect(`${appBaseUrl}/login?error=missing_code`);
    }
    return Response.redirect(
      `${appBaseUrl}/onboarding/connect-shopify?error=missing`
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
    const [, from, stateUserId] = state.split("___");
    const isFromDashboard = from === "dashboard";

    const shopData = shopDetails.shop || {};
    const storeEmail = shopData.email || shopData.customer_email || "";
    const storeOwner = shopData.shop_owner || shopData.name || "Store Owner";
    const customDomain = shopData.domain || null;
    const myshopifyUrl = shopData.myshopify_domain || shop;

    console.log("Shopify custom domain:", customDomain);
    console.log("Shopify myshopify URL:", myshopifyUrl);
    console.log("Shopify store email:", storeEmail);

    // Shopify data payload — store token + refresh token + expiry
    const shopifyData: Record<string, unknown> = {
      shopify_store_url: myshopifyUrl,
      shopify_custom_domain: customDomain,
      shopify_access_token: accessToken,
      shop_domain: myshopifyUrl, // explicitly set shop_domain
      access_token: accessToken, // explicitly set access_token
      shopify_refresh_token: refreshToken,
      shopify_token_expires_at: tokenExpiresAt,
      shopify_scopes: tokenData.scope,
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
    if (cols.hasRefreshToken) {
      shopifyData.refresh_token = refreshToken;
    }
    if (cols.hasTokenExpiresAt) {
      shopifyData.token_expires_at = tokenExpiresAt;
    }

    // Resolve target Clerk user:
    // 1. Check if user is already signed in in this browser session or in state
    let targetUserId = userId || (stateUserId && stateUserId !== "anonymous" ? stateUserId : null);

    // 2. If unauthenticated, check if this store is already linked to an existing integration
    if (!targetUserId) {
      const existingIntegration = await getExistingIntegrationByStore(myshopifyUrl);
      if (existingIntegration?.clerk_user_id) {
        targetUserId = existingIntegration.clerk_user_id;
        console.log("Found existing integration for store:", myshopifyUrl, "→ user:", targetUserId);
      }
    }

    // 3. If still no user, check if a Clerk user already exists with the store contact email
    const { clerkClient } = await import("@clerk/nextjs/server");
    const clerk = await clerkClient();

    if (!targetUserId && storeEmail) {
      const existingUsers = await clerk.users.getUserList({ emailAddress: [storeEmail] });
      if (existingUsers.data && existingUsers.data.length > 0) {
        targetUserId = existingUsers.data[0].id;
        console.log("Found existing Clerk user by email:", storeEmail, "→ user:", targetUserId);
      }
    }

    // 4. If still no user, auto-create the Clerk user from Shopify store details!
    if (!targetUserId) {
      const nameParts = storeOwner.trim().split(/\s+/);
      const firstName = nameParts[0] || "Store";
      const lastName = nameParts.slice(1).join(" ") || "Owner";
      const cleanStoreSlug = myshopifyUrl.replace(/\.myshopify\.com$/i, "").replace(/[^a-zA-Z0-9_-]/g, "");
      const effectiveEmail =
        (storeEmail || "").trim() || `${cleanStoreSlug || "merchant"}@omnitarget.app`;

      const { randomBytes } = await import("crypto");
      const securePassword = randomBytes(16).toString("hex") + "A1!";

      try {
        const newUser = await clerk.users.createUser({
          emailAddress: [effectiveEmail],
          password: securePassword,
          firstName,
          lastName,
          publicMetadata: {
            onboardingStep: "audit",
            source: "shopify_install",
            shopifyStoreUrl: myshopifyUrl,
          },
        });
        targetUserId = newUser.id;
        console.log("Auto-created Clerk user for Shopify merchant:", targetUserId, effectiveEmail);
      } catch (createErr: unknown) {
        console.warn("Clerk createUser error, attempting fallback user resolution:", createErr);
        // If the email already exists in Clerk, resolve that user
        const existingByEmail = await clerk.users.getUserList({ emailAddress: [effectiveEmail] });
        if (existingByEmail.data && existingByEmail.data.length > 0) {
          targetUserId = existingByEmail.data[0].id;
          console.log("Resolved existing user on duplicate email conflict:", targetUserId);
        } else {
          throw createErr;
        }
      }
    }

    // Upsert the integration row matched by the resolved Clerk user ID
    console.log("Upserting user integration for Clerk user:", targetUserId);
    await upsertUserIntegration(targetUserId, shopifyData);

    console.log("Shopify upsert success");

    // Give 1 free credit on install if free_credit_used is false
    const { getUserIntegration } = await import("@/lib/db");
    const userIntegration = await getUserIntegration(targetUserId);
    const freeCreditUsedBefore = cols.hasFreeCreditUsed ? !!userIntegration?.free_credit_used : false;

    await handleFreeCreditOnInstall(targetUserId);

    if (!freeCreditUsedBefore && storeEmail) {
      try {
        const { sendEmail } = await import("@/lib/email");
        const { welcomeEmailHtml } = await import("@/emails/welcome");

        await sendEmail({
          to: storeEmail,
          subject: "Your free brief is waiting",
          html: welcomeEmailHtml(),
          userId: targetUserId,
          templateName: "welcome",
        });
        console.log("Welcome email sent to", storeEmail);
      } catch (err) {
        console.error("Failed to send welcome email:", err);
      }
    }

    // Register the orders/paid webhook so confirmed purchases
    // are forwarded to Meta CAPI for attribution
    const webhookUrl =
      `${process.env.NEXT_PUBLIC_APP_URL}` +
      `/api/shopify/webhook`;

    try {
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

      if (webhookData.webhook?.id) {
        await updateUserIntegration(targetUserId, {
          shopify_webhook_id: String(webhookData.webhook.id),
        });
      }
    } catch (whErr) {
      console.warn("Webhook registration warning:", whErr);
    }

    // Check onboarding status:
    // If the merchant already completed onboarding previously or logged in via "Continue with Shopify",
    // send them to /dashboard.
    // If this is a fresh install or audit hasn't been completed, kick off the audit!
    const targetUser = await clerk.users.getUser(targetUserId);
    const currentOnboardingStep = (targetUser.publicMetadata as { onboardingStep?: string })?.onboardingStep;
    const isAlreadyComplete = currentOnboardingStep === "complete";
    const isLogin = from === "login";
    const shouldSkipAudit = isFromDashboard || isAlreadyComplete || (isLogin && !!userIntegration);

    // Update Clerk metadata directly — store is connected, so step is either complete or audit
    await clerk.users.updateUserMetadata(targetUserId, {
      publicMetadata: {
        shopifyStoreUrl: myshopifyUrl,
        onboardingStep: shouldSkipAudit ? "complete" : "audit",
      },
    });

    const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, "");
    const destination = shouldSkipAudit ? "/dashboard" : "/onboarding/audit";

    // If the merchant is already logged into Clerk in this browser, redirect directly
    if (userId) {
      return Response.redirect(`${appBaseUrl}${destination}`);
    }

    // Otherwise (Shopify App Store install or Login with Shopify):
    // Issue a single-use sign-in ticket so the browser authenticates instantly without a password
    const signInToken = await clerk.signInTokens.createSignInToken({
      userId: targetUserId,
      expiresInSeconds: 300,
    });

    const ssoUrl = `${appBaseUrl}/auth/shopify-callback?token=${encodeURIComponent(
      signInToken.token
    )}&destination=${encodeURIComponent(destination)}`;

    return Response.redirect(ssoUrl);

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Shopify OAuth error:", errMsg, err);
    const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, "");
    return Response.redirect(
      `${appBaseUrl}/login?error=shopify_auth_failed&detail=${encodeURIComponent(errMsg.slice(0, 120))}`
    );
  }
}
