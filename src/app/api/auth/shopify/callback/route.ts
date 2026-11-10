import { auth } from "@clerk/nextjs/server";
import {
  disconnectShopInstallation,
  getUserIdsLinkedToStore,
  getUserIntegration,
  upsertUserIntegration,
  updateUserIntegration,
} from "@/lib/db";
import {
  INSTALL_LEASE_SECONDS,
  installUnderLease,
  type CommitInput,
  type ExchangedToken,
  type InstallResult,
  type ShopIdentity,
} from "@/modules/workspaces/install";
import { connectionRefusalMessage, parseShopifyShopId } from "@/modules/workspaces/lifecycle";
import {
  acquireInstallLease,
  commitShopInstallUnderLease,
  connectCheckUnderLease,
  installLeaseHeld,
  releaseInstallLease,
  shopOwner,
  transferForRequester,
  verifyOwnershipTransfer,
  type BindOutcome,
} from "@/modules/workspaces/repository";
import { sealShopCredential } from "@/modules/credentials/shopify";
import { workspaceCookie } from "@/modules/workspaces/current";
import { grantFreeCredit, type FreeCreditOutcome } from "@/modules/credits/ledger";
import { createLogger } from "@/platform/logger";
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
const TRANSFER_FAILURE = "This store transfer is not ready to complete. Check its status and try again.";
const BUSY_FAILURE = "This store is being connected right now. Please try again in a minute.";

/** Exchanges the single-use code for an expiring offline token. Never retried (ING-04). */
async function exchangeShopifyCode(shop: string, code: string): Promise<ExchangedToken> {
  const response = await fetchWithRetry(
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
    { timeoutMs: 12000, retries: 0 },
  );
  const data = await response.json().catch(() => ({}));
  if (!data.access_token) {
    console.error("Shopify token exchange failed:", { status: response.status, error: data?.error ?? null });
    throw new Error("No access token returned");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in || null,
    scope: data.scope ?? null,
  };
}

/** Shopify's immutable shop id is the store's identity; the domain can change. */
async function fetchShopIdentity(shop: string, accessToken: string): Promise<ShopIdentity> {
  const response = await fetch(shopifyAdminRestUrl(shop, "shop.json"), {
    headers: { "X-Shopify-Access-Token": accessToken },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  const details = (body?.shop ?? {}) as Record<string, unknown>;
  const id = parseShopifyShopId(details.id);
  if (!id) throw new Error("Shopify returned no shop id");
  const reported = String(details.myshopify_domain || "").toLowerCase();
  return {
    id,
    myshopifyDomain: isValidShopDomain(reported) ? reported : shop,
    name: typeof details.name === "string" ? details.name : null,
    details,
  };
}

const log = createLogger({ module: "shopify-oauth-callback" });

/**
 * Records the store on the account's legacy row: its domains and scopes only,
 * for the parts of the app that still read them (store snapshot, onboarding).
 * The credential itself is encrypted and committed with the binding (task 4);
 * no token is written here. After a transfer, the previous owner's legacy
 * tokens are cleared: the new owner's exchange retired them at Shopify.
 */
async function recordStoreOnAccount(input: CommitInput): Promise<void> {
  const domain = input.identity.myshopifyDomain;
  if (input.transferId && !(await disconnectShopInstallation(domain))) throw new Error("previous_credentials_not_cleared");
  await upsertUserIntegration(input.actor, {
    shopify_store_url: domain,
    shop_domain: domain,
    shopify_custom_domain: typeof input.identity.details.domain === "string" ? input.identity.details.domain : null,
    shopify_scopes: input.token.scope,
    shopify_uninstalled_at: null,
  });
}

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
      // The shop's owner when it is bound; legacy links only for a shop not yet modelled.
      const owner = await shopOwner(shop);
      linkedUserIds = owner ? [owner] : await getUserIdsLinkedToStore(shop);
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

  // A transfer is verified by the requester completing Shopify's authorization
  // for the shop. The code is deliberately not exchanged: the current owner
  // keeps working until they approve.
  if (state.tr) {
    if (decision.kind !== "link_to_session") return failure(TRANSFER_FAILURE);
    try {
      const transfer = await transferForRequester(state.tr, targetUserId);
      if (!transfer || transfer.shop_domain !== shop) return failure(TRANSFER_FAILURE);
      if (transfer.status === "requested") {
        await verifyOwnershipTransfer(state.tr, targetUserId, shop);
        return redirectTo(`${appBaseUrl}/dashboard?transfer=verified`, [clearState]);
      }
      if (transfer.status !== "approved") return failure(TRANSFER_FAILURE);
    } catch (err) {
      console.error("Transfer check failed:", err instanceof Error ? err.message : "unknown error");
      return failure(TRANSFER_FAILURE);
    }
  }

  // Phase 1 task 3.1: from the ownership decision to the stored credential,
  // everything runs under the shop's install lease, so an account that may not
  // own the shop never reaches the code exchange that would retire the owner's
  // token (see installUnderLease).
  let installed: InstallResult;
  try {
    installed = await installUnderLease(
      { shop, code, actor: targetUserId, selectedWorkspaceId: state.ws, transferId: state.tr },
      {
        acquireLease: (domain, actor) => acquireInstallLease(domain, actor, INSTALL_LEASE_SECONDS),
        releaseLease: releaseInstallLease,
        leaseHeld: installLeaseHeld,
        check: connectCheckUnderLease,
        exchangeCode: exchangeShopifyCode,
        fetchShop: fetchShopIdentity,
        // Binding and encrypted credential commit together, under the lease (0020).
        commit: (input) =>
          commitShopInstallUnderLease({
            leaseDomain: input.shop,
            holder: input.holder,
            shopifyShopId: input.identity.id,
            domain: input.identity.myshopifyDomain,
            actor: input.actor,
            selectedWorkspaceId: input.selectedWorkspaceId,
            shopName: input.identity.name,
            transferId: input.transferId,
            credential: sealShopCredential(input.identity.id, input.token),
          }),
        persist: recordStoreOnAccount,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );
  } catch (err) {
    log.error("Shopify installation failed", { shop }, err);
    return failure(state.tr ? TRANSFER_FAILURE : GENERIC_FAILURE);
  }

  if (installed.kind !== "connected") {
    const outcome = installed.kind === "refused" ? installed.outcome : installed.kind;
    log.warn("Shopify installation ended without connecting", { shop, outcome });
    if (installed.kind === "busy") return failure(BUSY_FAILURE);
    if (installed.kind === "lease_lost") return failure(GENERIC_FAILURE);
    if (installed.outcome === "rejected_transfer_not_ready") return failure(TRANSFER_FAILURE);
    return failure(connectionRefusalMessage(installed.outcome as BindOutcome));
  }

  try {
    const shopData = installed.identity.details;
    const accessToken = installed.token.accessToken;
    const storeEmail = String(shopData.email || shopData.customer_email || "");
    const customDomain = typeof shopData.domain === "string" ? shopData.domain : null;
    const myshopifyUrl = installed.identity.myshopifyDomain;

    // The Online Store theme exposes its own logo, even when the merchant has
    // not configured Shopify Brand assets. Use its original image size.
    const storeLogoUrl = await fetchShopifyStoreLogo(myshopifyUrl, customDomain);
    const storeName: string = installed.identity.name || "Store";

    // An existing account row marks a returning login (onboarding skip below).
    const userIntegration = await getUserIntegration(targetUserId);

    // One free credit per workspace and per shop, through the ledger.
    let freeCredit: FreeCreditOutcome | "failed" | "skipped" = "skipped";
    if (installed.result.workspace_id) {
      try {
        freeCredit = await grantFreeCredit(installed.result.workspace_id, targetUserId);
      } catch (err) {
        freeCredit = "failed";
        log.error("Free install credit could not be granted", { shop }, err);
      }
    }

    if (freeCredit === "granted" && storeEmail) {
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

    // SEC-09: revoke stored access as soon as the app is removed. shop/update
    // lets a myshopify domain change be followed by shop id (task 3.1).
    for (const topic of ["app/uninstalled", "shop/update"]) {
      try {
        await fetch(shopifyAdminRestUrl(shop, "webhooks.json"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            webhook: { topic, address: webhookUrl, format: "json" },
          }),
        });
      } catch (whErr) {
        console.warn(`${topic} webhook registration warning:`, whErr instanceof Error ? whErr.message : whErr);
      }
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
    // The workspace just connected becomes the browser's current workspace.
    if (installed.result.workspace_id) cookies.push(workspaceCookie(installed.result.workspace_id));
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
