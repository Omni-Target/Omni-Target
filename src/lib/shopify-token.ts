import { getUserIntegration, updateUserIntegration } from "./db";

/**
 * Ensures the Shopify access token for a given user is still valid.
 * If the token has expired and a refresh token is available, it will
 * automatically rotate the token and update the database.
 *
 * Returns the valid access token, or null if refresh failed.
 */
export async function getValidShopifyToken(
  userId: string
): Promise<{ accessToken: string; shopUrl: string } | null> {
  const integration = await getUserIntegration(userId);

  if (!integration?.shopify_access_token || !integration?.shopify_store_url) {
    return null;
  }

  const expiresAt = integration.shopify_token_expires_at
    ? new Date(integration.shopify_token_expires_at).getTime()
    : null;

  // If no expiry info, assume the token is valid (legacy non-expiring token
  // that hasn't been migrated yet — the API call itself will fail with 403
  // if it's truly expired, which is handled by the caller)
  if (!expiresAt) {
    return {
      accessToken: integration.shopify_access_token,
      shopUrl: integration.shopify_store_url,
    };
  }

  // Add 5-minute buffer so we refresh before actual expiration
  const FIVE_MINUTES = 5 * 60 * 1000;
  const isExpired = Date.now() > expiresAt - FIVE_MINUTES;

  if (!isExpired) {
    return {
      accessToken: integration.shopify_access_token,
      shopUrl: integration.shopify_store_url,
    };
  }

  // Token expired — attempt refresh
  if (!integration.shopify_refresh_token) {
    console.error("Token expired but no refresh token available for user:", userId);
    return null;
  }

  console.log("Refreshing expired Shopify token for user:", userId);

  try {
    const refreshRes = await fetch(
      `https://${integration.shopify_store_url}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: integration.shopify_refresh_token,
        }),
      }
    );

    const refreshData = await refreshRes.json();

    if (!refreshData.access_token) {
      console.error("Token refresh failed:", refreshData);
      return null;
    }

    const newExpiresAt = refreshData.expires_in
      ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
      : null;

    // Update DB with new token + new refresh token
    const updateData: Record<string, any> = {
      shopify_access_token: refreshData.access_token,
    };
    if (refreshData.refresh_token) {
      updateData.shopify_refresh_token = refreshData.refresh_token;
    }
    if (newExpiresAt) {
      updateData.shopify_token_expires_at = newExpiresAt;
    }

    await updateUserIntegration(userId, updateData);

    console.log("Token refreshed successfully for user:", userId);

    return {
      accessToken: refreshData.access_token,
      shopUrl: integration.shopify_store_url,
    };
  } catch (err) {
    console.error("Token refresh error:", err);
    return null;
  }
}
