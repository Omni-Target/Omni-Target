import { auth } from "@clerk/nextjs/server";
import { validateShopifyInput } from "@/lib/domain-validation";
import { SHOPIFY_SCOPE_PARAM } from "@/lib/shopify-config";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  PENDING_INSTALL_COOKIE,
  clearCookie,
  createOAuthState,
  isValidShopDomain,
  normalizeFrom,
  normalizePlan,
  readCookie,
  readPendingInstall,
  serializeCookie,
  uuidOrNull,
} from "@/lib/shopify-oauth";

/**
 * Starts Shopify OAuth.
 *
 * Security model (SEC-01): the `state` sent to Shopify is an opaque random
 * nonce. The flow context — shop, origin, plan and the Clerk user who started
 * the flow — lives in an HMAC-signed httpOnly cookie bound to this browser, and
 * the callback only proceeds when the returned `state` matches that cookie.
 *
 * `?resume=1` continues an install that previously arrived without a session
 * (App Store install / "Continue with Shopify" for a store not yet linked):
 * after the merchant signs in or signs up, OAuth is re-run from scratch for the
 * pending shop, this time bound to their authenticated session.
 */
export async function GET(request: Request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  const cookieHeader = request.headers.get("cookie");
  const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, "");

  let shop = searchParams.get("shop")?.trim() || "";
  let from = normalizeFrom(searchParams.get("from"), Boolean(userId));
  let selectedPlan = normalizePlan(
    searchParams.get("plan") || readCookie(cookieHeader, "selected_plan"),
  );
  let clearPending = false;

  if (searchParams.get("resume") === "1") {
    const pending = readPendingInstall(readCookie(cookieHeader, PENDING_INSTALL_COOKIE));
    if (!userId) {
      // Resuming requires an authenticated session; the pending cookie stays so
      // the login page can offer to finish connecting the store.
      return Response.redirect(`${appBaseUrl}/login`, 302);
    }
    if (pending) {
      shop = pending.shop;
      from = pending.from;
      selectedPlan = pending.plan || selectedPlan;
    }
    clearPending = true;
  }

  const returnTarget = from === "login" ? "login" : "signup";
  const planQuery = selectedPlan ? `&plan=${encodeURIComponent(selectedPlan)}` : "";

  if (!shop && userId) {
    const { getUserIntegration } = await import("@/lib/db");
    const integration = await getUserIntegration(userId);
    shop = integration?.shopify_store_url || integration?.shop_domain || "";
  }

  if (!shop) {
    if (!userId) {
      return Response.redirect(`${appBaseUrl}/${returnTarget}?error=missing_shop${planQuery}`, 302);
    }
    if (clearPending) {
      return Response.redirect(`${appBaseUrl}/onboarding/connect-shopify`, 302);
    }
    return Response.json({ error: "Shop parameter required" }, { status: 400 });
  }

  // Validate store domain format strictly
  const validation = validateShopifyInput(shop);
  if (!validation.isValid) {
    return Response.redirect(
      `${appBaseUrl}/${returnTarget}?error=invalid_domain&detail=${encodeURIComponent(
        validation.error || "Please enter a valid domain (e.g. yourstore.com or store.myshopify.com)",
      )}${planQuery}`,
      302,
    );
  }

  shop = validation.normalized;

  if (validation.isCustomDomain) {
    try {
      const { resolveShopifyDomain } = await import("@/lib/shopify-resolver");
      const resolved = await resolveShopifyDomain(shop);
      if (resolved.isShopify && resolved.myshopifyDomain) {
        shop = resolved.myshopifyDomain.trim().toLowerCase();
      } else {
        return Response.redirect(
          `${appBaseUrl}/${returnTarget}?error=store_not_found&detail=${encodeURIComponent(
            resolved.error ||
              "We could not find a Shopify store at this domain. Please check the URL or use your store.myshopify.com domain.",
          )}${planQuery}`,
          302,
        );
      }
    } catch (resolveErr) {
      console.warn("Domain resolution error:", resolveErr instanceof Error ? resolveErr.message : resolveErr);
      return Response.redirect(
        `${appBaseUrl}/${returnTarget}?error=store_resolution_failed&detail=${encodeURIComponent(
          "We could not verify this Shopify store. Please check the domain or use your store.myshopify.com domain.",
        )}${planQuery}`,
        302,
      );
    }
  }

  // Never send a merchant's browser to an arbitrary host: the authorize URL is
  // only ever built for a genuine *.myshopify.com shop.
  if (!isValidShopDomain(shop)) {
    return Response.redirect(
      `${appBaseUrl}/${returnTarget}?error=store_not_found&detail=${encodeURIComponent(
        "We could not verify this Shopify store. Please use your store.myshopify.com domain.",
      )}${planQuery}`,
      302,
    );
  }

  // A signed-in user may name the workspace to bind, or the ownership transfer
  // this flow verifies or completes. These only select; the database decides
  // whether this user may use them.
  const { nonce, cookieValue } = createOAuthState({
    shop,
    from,
    plan: selectedPlan,
    initiatorUserId: userId ?? null,
    workspaceId: clearPending ? null : uuidOrNull(searchParams.get("workspace")),
    transferId: clearPending ? null : uuidOrNull(searchParams.get("transfer")),
  });

  const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
  authorize.searchParams.set("client_id", process.env.SHOPIFY_CLIENT_ID || "");
  authorize.searchParams.set("scope", SHOPIFY_SCOPE_PARAM);
  authorize.searchParams.set("redirect_uri", `${appBaseUrl}/api/auth/shopify/callback`);
  authorize.searchParams.set("state", nonce);

  const response = new Response(null, {
    status: 302,
    headers: new Headers({ Location: authorize.toString(), "Cache-Control": "no-store" }),
  });
  response.headers.append("Set-Cookie", serializeCookie(OAUTH_STATE_COOKIE, cookieValue, OAUTH_STATE_TTL_SECONDS));
  if (clearPending) response.headers.append("Set-Cookie", clearCookie(PENDING_INSTALL_COOKIE));
  if (selectedPlan) {
    response.headers.append(
      "Set-Cookie",
      `selected_plan=${selectedPlan}; Secure; SameSite=Lax; Max-Age=3600; Path=/`,
    );
  }
  return response;
}
