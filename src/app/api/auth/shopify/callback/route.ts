import { auth } from "@clerk/nextjs/server";
import { getUserIdsLinkedToStore, upsertUserIntegration, updateUserIntegration } from "@/lib/db";
import { fetchWithRetry } from "@/lib/http";
import { shopifyAdminRestUrl } from "@/lib/shopify-config";
import { fetchShopifyStoreLogo } from "@/lib/shopify-store-logo";
import { normalizeStoreLogoUrl } from "@/lib/store-logo-url";
import { safeInternalPath } from "@/lib/safe-redirect";
import {
  OAUTH_STATE_COOKIE,
  PENDING_INSTALL_COOKIE,
  PENDING_INSTALL_TTL_SECONDS,
  clearCookie,
  createPendingInstall,
  isFreshShopifyTimestamp,
  isValidShopDomain,
  readCookie,
  readOAuthState,
  resolveCallbackDecision,
  serializeCookie,
  verifyShopifyQueryHmac,
} from "@/lib/shopify-oauth";

/**
 * Shopify OAuth callback.
 *
 * Security model (SEC-01):
 *   1. The redirect must carry a valid Shopify HMAC, a genuine *.myshopify.com
 *      shop and a fresh timestamp.
 *   2. The returned `state` must equal the nonce in this browser's signed
 *      `shopify_oauth_state` cookie, for the same shop. The cookie is single-use.
 *   3. The account is chosen by `resolveCallbackDecision`: the browser's own
 *      Clerk session, or — for a signed-out "Continue with Shopify" — the one
 *      account already linked to this exact shop. Nothing in the URL and not
 *      the shop's contact email can select an account, and accounts are never
 *      created here. A signed-out install for an unlinked (or ambiguously
 *      linked) shop becomes a pending install that resumes after sign-in.
 */
const GENERIC_FAILURE = "We could not complete the Shopify connection. Please try again.";

function redirectTo(url: string, cookies: string[] = []): Response {
  const response = new Response(null, {
    status: 302,
    headers: new Headers({ Location: url, "Cache-Control": "no-store" }),
  });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const searchParams = url.searchParams;
  const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || url.origin).replace(/\/$/, "");
  const clearState = clearCookie(OAUTH_STATE_COOKIE);

  // 1. The redirect itself must come from Shopify.
  if (!verifyShopifyQueryHmac(searchParams, process.env.SHOPIFY_CLIENT_SECRET)) {
    return Response.json({ error: "Invalid HMAC" }, { status: 401, headers: { "Set-Cookie": clearState } });
  }

  const shop = (searchParams.get("shop") || "").trim().toLowerCase();
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state") || "";
  const statePayload = readOAuthState(readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE));
  const errorPage = statePayload?.from === "login" ? "login" : "signup";
  const failure = (detail: string) =>
    redirectTo(
      `${appBaseUrl}/${errorPage}?error=shopify_auth_failed&detail=${encodeURIComponent(detail)}`,
      [clearState],
    );

  if (!isValidShopDomain(shop) || !isFreshShopifyTimestamp(searchParams.get("timestamp"))) {
    return failure("This Shopify sign-in link is invalid or has expired. Please try again.");
  }

  if (!code) {
    if (statePayload?.from === "login") {
      return redirectTo(`${appBaseUrl}/login?error=missing_code`, [clearState]);
    }
    return redirectTo(`${appBaseUrl}/onboarding/connect-shopify?error=missing`, [clearState]);
  }

  const { userId } = await auth();
  const sessionUserId = userId ?? null;

  // Accounts already linked to this exact shop are only consulted for a
  // signed-out browser whose state cookie matches this shop.
  let linkedUserIds: string[] = [];
  if (!sessionUserId && statePayload && statePayload.shop === shop) {
    try {
      linkedUserIds = await getUserIdsLinkedToStore(shop);
    } catch (lookupErr) {
      console.error("Shopify OAuth: store link lookup failed:", lookupErr instanceof Error ? lookupErr.message : lookupErr);
      return failure(GENERIC_FAILURE);
    }
  }

  const decision = resolveCallbackDecision({ sessionUserId, statePayload, stateParam, shop, linkedUserIds });

  if (decision.kind === "reject") {
    console.warn(`Shopify OAuth callback rejected: ${decision.reason}`);
    return failure(
      decision.reason === "session_mismatch"
        ? "You switched accounts while connecting Shopify. Please start the connection again."
        : "Your Shopify sign-in expired or was started in another browser. Please try again.",
    );
  }

  // resolveCallbackDecision only returns non-reject outcomes for a valid state.
  const state = statePayload!;
  const selectedPlan = state.plan;
  const planQuery = selectedPlan ? `&plan=${encodeURIComponent(selectedPlan)}` : "";

  if (decision.kind === "pending_install") {
    // Signed-out install for a store with no (or several) linked accounts: the
    // merchant must sign in or create an account first; OAuth then re-runs
    // bound to that session (see /api/auth/shopify/connect?resume=1).
    const ambiguous = decision.reason === "ambiguous_linked_accounts";
    const page = ambiguous || state.from === "login" ? "login" : "signup";
    const pending = createPendingInstall({ shop, from: state.from, plan: selectedPlan });
    return redirectTo(
      `${appBaseUrl}/${page}?pending=shopify${ambiguous ? "&reason=multiple_accounts" : ""}${planQuery}`,
      [clearState, serializeCookie(PENDING_INSTALL_COOKIE, pending, PENDING_INSTALL_TTL_SECONDS)],
    );
  }

  const targetUserId = decision.userId;
  const isFromDashboard = state.from === "dashboard";
  const isLogin = state.from === "login";
  const hasPaidPlan = ["starter", "growth", "scale"].includes(selectedPlan);

  try {
    // Exchange code for an EXPIRING offline access token ("expiring": 1 returns
    // an expiring token + refresh token instead of a non-expiring token).
    const tokenRes = await fetchWithRetry(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          code,
          expiring: 1,
        }),
      },
      // Never retried: authorization codes are single-use (ING-04).
      { timeoutMs: 12000, retries: 0 },
    );

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = tokenData.expires_in || null; // seconds

    if (!accessToken) {
      console.error("Shopify token exchange failed:", {
        status: tokenRes.status,
        error: tokenData?.error ?? null,
        description: tokenData?.error_description ?? null,
      });
      throw new Error("No access token returned");
    }

    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    // Fetch shop details to get the primary custom domain
    const shopDetailsRes = await fetch(shopifyAdminRestUrl(shop, "shop.json"), {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    const shopDetails = await shopDetailsRes.json();

    const shopData = shopDetails.shop || {};
    const storeEmail: string = shopData.email || shopData.customer_email || "";
    const customDomain = shopData.domain || null;
    const reportedDomain = String(shopData.myshopify_domain || "").toLowerCase();
    const myshopifyUrl = isValidShopDomain(reportedDomain) ? reportedDomain : shop;

    // The Online Store theme exposes its own logo, even when the merchant has
    // not configured Shopify Brand assets. Use its original image size.
    const storeLogoUrl = await fetchShopifyStoreLogo(myshopifyUrl, customDomain);
    const storeName: string = shopData.name || "Store";

    // Shopify data payload — store token + refresh token + expiry
    const shopifyData: Record<string, unknown> = {
      shopify_store_url: myshopifyUrl,
      shopify_custom_domain: customDomain,
      shopify_access_token: accessToken,
      shop_domain: myshopifyUrl,
      access_token: accessToken,
      shopify_refresh_token: refreshToken,
      shopify_token_expires_at: tokenExpiresAt,
      shopify_scopes: tokenData.scope,
    };

    // Populate new schema columns if they exist (backward compatibility)
    const { detectColumns, handleFreeCreditOnInstall } = await import("@/lib/billing-db");
    const cols = await detectColumns();
    if (cols.hasShopDomain) shopifyData.shop_domain = myshopifyUrl;
    if (cols.hasAccessToken) shopifyData.access_token = accessToken;
    if (cols.hasRefreshToken) shopifyData.refresh_token = refreshToken;
    if (cols.hasTokenExpiresAt) shopifyData.token_expires_at = tokenExpiresAt;

    await upsertUserIntegration(targetUserId, shopifyData);

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
      } catch (err) {
        console.error("Failed to send welcome email:", err instanceof Error ? err.message : err);
      }
    }

    // Register the orders/paid webhook so confirmed purchases
    // are forwarded to Meta CAPI for attribution
    const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/shopify/webhook`;
    try {
      const webhookRes = await fetch(shopifyAdminRestUrl(shop, "webhooks.json"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          webhook: { topic: "orders/paid", address: webhookUrl, format: "json" },
        }),
      });
      const webhookData = await webhookRes.json();
      if (webhookData.webhook?.id) {
        await updateUserIntegration(targetUserId, {
          shopify_webhook_id: String(webhookData.webhook.id),
        });
      }
    } catch (whErr) {
      console.warn("Webhook registration warning:", whErr instanceof Error ? whErr.message : whErr);
    }

    // SEC-09: revoke stored access as soon as the app is removed.
    try {
      await fetch(shopifyAdminRestUrl(shop, "webhooks.json"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          webhook: { topic: "app/uninstalled", address: webhookUrl, format: "json" },
        }),
      });
    } catch (whErr) {
      console.warn("Uninstall webhook registration warning:", whErr instanceof Error ? whErr.message : whErr);
    }

    // Onboarding: skip the audit for completed merchants, paid-plan intents,
    // dashboard reconnects and returning "Continue with Shopify" logins.
    const { clerkClient } = await import("@clerk/nextjs/server");
    const clerk = await clerkClient();
    const targetUser = await clerk.users.getUser(targetUserId);
    const currentOnboardingStep = (targetUser.publicMetadata as { onboardingStep?: string })?.onboardingStep;
    const isAlreadyComplete = currentOnboardingStep === "complete";
    const shouldSkipAudit = hasPaidPlan || isFromDashboard || isAlreadyComplete || (isLogin && !!userIntegration);

    const existingMeta = (targetUser.publicMetadata || {}) as Record<string, unknown>;
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      shopifyStoreUrl: myshopifyUrl,
      onboardingStep: shouldSkipAudit ? "complete" : "audit",
      storeLogoUrl:
        storeLogoUrl ||
        (existingMeta.shopifyStoreUrl === myshopifyUrl
          ? normalizeStoreLogoUrl(existingMeta.storeLogoUrl as string | undefined)
          : null),
    };
    if (storeName) updatedMeta.storeName = storeName;
    await clerk.users.updateUserMetadata(targetUserId, { publicMetadata: updatedMeta });

    let destination = shouldSkipAudit ? "/dashboard" : "/onboarding/audit";
    if (selectedPlan) destination += `?plan=${encodeURIComponent(selectedPlan)}`;
    if (isFromDashboard) destination += `${destination.includes("?") ? "&" : "?"}shopify=reconnected`;
    destination = safeInternalPath(destination);

    const cookies = [clearState];
    if (selectedPlan) {
      cookies.push(`selected_plan=${selectedPlan}; Secure; SameSite=Lax; Max-Age=3600; Path=/`);
    }

    if (decision.kind === "link_to_session") {
      return redirectTo(`${appBaseUrl}${destination}`, cookies);
    }

    // decision.kind === "sign_in_linked_user": signed-out "Continue with
    // Shopify" for a store already linked to exactly one account. Completing
    // OAuth for this shop proves admin access to it; issue a single-use ticket.
    const signInToken = await clerk.signInTokens.createSignInToken({
      userId: targetUserId,
      expiresInSeconds: 300,
    });
    return redirectTo(
      `${appBaseUrl}/auth/shopify-callback?token=${encodeURIComponent(signInToken.token)}&destination=${encodeURIComponent(destination)}`,
      cookies,
    );
  } catch (err: unknown) {
    console.error("Shopify OAuth error:", err instanceof Error ? err.message : "unknown error");
    return failure(GENERIC_FAILURE);
  }
}
