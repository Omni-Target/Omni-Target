import {
  getUserIntegration,
  updateUserIntegration,
  detectDbColumns,
} from "./db";

/**
 * Result of resolving a Shopify access token for a user.
 *
 * - `ok`: a usable access token is available.
 * - `not_connected`: no Shopify integration / no stored credentials.
 * - `reauth_required`: credentials exist but the refresh token is no longer
 *   valid (Shopify returned 401 / invalid_request). The merchant must re-run
 *   the OAuth install flow — retrying will not help. We deliberately do NOT
 *   delete the stored tokens here, because a single transient 401 can also be
 *   caused by the rotation race (another concurrent request rotated first);
 *   the caller should prompt a reconnect rather than us destroying state.
 */
export type ShopifyTokenResult =
  | { status: "ok"; accessToken: string; shopUrl: string }
  | { status: "not_connected" }
  | { status: "reauth_required"; shopUrl: string };

/**
 * In-flight refresh promises keyed by userId. Shopify refresh tokens are
 * single-use and rotate on every refresh, so two concurrent refreshes will
 * burn the token (the second sends an already-consumed token and gets a 401).
 * De-duplicating concurrent refreshes within this process collapses them into
 * a single network call so they all observe the same rotated token.
 *
 * Note: this only guards races within a single runtime instance. Separate
 * serverless instances refreshing simultaneously can still collide; that
 * residual race surfaces as a transient `reauth_required` that self-heals on
 * the next request (the winning instance has already persisted a fresh token).
 */
const inflightRefreshes = new Map<string, Promise<ShopifyTokenResult>>();

/**
 * Ensures the Shopify access token for a given user is still valid.
 * If the token has expired or is within 24 hours of expiring, and a refresh
 * token is available, it will automatically rotate the token and update the DB.
 */
export async function getValidShopifyToken(
  userId: string,
): Promise<ShopifyTokenResult> {
  const integration = await getUserIntegration(userId);

  if (!integration) {
    return { status: "not_connected" };
  }

  // Support both prefix and non-prefix columns for access token and shop URL
  const accessToken =
    integration.shopify_access_token || integration.access_token;
  const shopUrl = integration.shopify_store_url || integration.shop_domain;

  if (!accessToken || !shopUrl) {
    return { status: "not_connected" };
  }

  // Get expiry timestamp, prioritizing token_expires_at then shopify_token_expires_at
  const rawExpiresAt =
    integration.token_expires_at || integration.shopify_token_expires_at;
  const expiresAt = rawExpiresAt ? new Date(rawExpiresAt).getTime() : null;

  // If no expiry info, assume the token is valid (legacy non-expiring token
  // that hasn't been migrated yet — the API call itself will fail with 403
  // if it's truly expired, which is handled by the caller)
  if (!expiresAt) {
    return { status: "ok", accessToken, shopUrl };
  }

  // Check if token is within 24 hours of expiry
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const isWithin24HoursOfExpiry = Date.now() > expiresAt - TWENTY_FOUR_HOURS;

  if (!isWithin24HoursOfExpiry) {
    return { status: "ok", accessToken, shopUrl };
  }

  // Token is within 24 hours of expiry — attempt refresh
  const refreshToken =
    integration.refresh_token || integration.shopify_refresh_token;
  if (!refreshToken) {
    console.error(
      "Token within 24 hours of expiry but no refresh token available for user:",
      userId,
    );
    // No way to refresh — the merchant needs to reconnect.
    return { status: "reauth_required", shopUrl };
  }

  // Collapse concurrent refreshes for the same user into one network call so
  // we don't burn the single-use refresh token (see inflightRefreshes above).
  const existing = inflightRefreshes.get(userId);
  if (existing) {
    return existing;
  }

  const refreshPromise = refreshShopifyToken(
    userId,
    shopUrl,
    accessToken,
    refreshToken,
  ).finally(() => {
    inflightRefreshes.delete(userId);
  });
  inflightRefreshes.set(userId, refreshPromise);

  return refreshPromise;
}

/**
 * Performs the actual token rotation against Shopify and persists the result.
 * Separated out so it can be wrapped by the single-flight guard above.
 */
async function refreshShopifyToken(
  userId: string,
  shopUrl: string,
  currentAccessToken: string,
  refreshToken: string,
): Promise<ShopifyTokenResult> {
  console.log(
    "Shopify token is within 24 hours of expiry or already expired. Refreshing for user:",
    userId,
  );

  // Normalize the host: strip any protocol/path so we always hit the
  // Shopify admin OAuth endpoint and never a storefront/custom domain
  // (which would return an HTML error page instead of JSON).
  const shopHost = shopUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const refreshUrl = `https://${shopHost}/admin/oauth/access_token`;

  try {
    const refreshRes = await fetch(refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    // Guard against non-JSON responses (HTML error/redirect pages). Without
    // this, refreshRes.json() throws "Unexpected token '<'" on an HTML body.
    const contentType = refreshRes.headers.get("content-type") || "";
    const rawBody = await refreshRes.text();

    if (!refreshRes.ok || !contentType.includes("application/json")) {
      console.error(
        `Token refresh failed for user ${userId}: HTTP ${refreshRes.status} ` +
          `(content-type: ${contentType || "none"}) from ${refreshUrl}. ` +
          `Body: ${rawBody.slice(0, 300)}`,
      );

      // A 401 / invalid_request means the refresh token itself is dead
      // (expired or already consumed via rotation). This is terminal — the
      // merchant must reconnect.
      if (isDeadRefreshToken(refreshRes.status, rawBody)) {
        return { status: "reauth_required", shopUrl };
      }
      // Anything else (5xx, HTML proxy error, etc.) is potentially transient.
      // We're only within the 24h expiry window, so the current token is most
      // likely still valid — keep the session working and retry next time.
      return { status: "ok", accessToken: currentAccessToken, shopUrl };
    }

    const refreshData = JSON.parse(rawBody);

    if (!refreshData.access_token) {
      console.error("Token refresh failed (no access_token):", refreshData);
      return { status: "reauth_required", shopUrl };
    }

    const newExpiresAt = refreshData.expires_in
      ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
      : null;

    // Detect DB columns to update dynamically
    const cols = await detectDbColumns();
    const updateData: Record<string, string> = {
      shopify_access_token: refreshData.access_token,
    };

    if (cols.hasAccessToken) {
      updateData.access_token = refreshData.access_token;
    }

    // Set new refresh token in all columns that exist
    const newRefreshToken = refreshData.refresh_token || refreshToken;
    updateData.shopify_refresh_token = newRefreshToken;
    if (cols.hasRefreshToken) {
      updateData.refresh_token = newRefreshToken;
    }

    // Set new expiry in all columns that exist
    if (newExpiresAt) {
      updateData.shopify_token_expires_at = newExpiresAt;
      if (cols.hasTokenExpiresAt) {
        updateData.token_expires_at = newExpiresAt;
      }
    }

    await updateUserIntegration(userId, updateData);

    console.log("Token refreshed successfully for user:", userId);

    return {
      status: "ok",
      accessToken: refreshData.access_token,
      shopUrl,
    };
  } catch (err) {
    console.error("Token refresh error:", err);
    // Network/parse error — transient. The current token is still within its
    // validity window, so keep the session working and retry on the next call.
    return { status: "ok", accessToken: currentAccessToken, shopUrl };
  }
}

/**
 * True when Shopify's response indicates the refresh token is permanently
 * invalid (so retrying is pointless and the merchant must reconnect).
 */
function isDeadRefreshToken(status: number, body: string): boolean {
  if (status !== 401 && status !== 400) {
    return false;
  }
  return /invalid_request|invalid_grant|active refresh_token/i.test(body);
}
