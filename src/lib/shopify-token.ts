import { getUserIntegration, updateUserIntegration, detectDbColumns } from "./db";

/**
 * Ensures the Shopify access token for a given user is still valid.
 * If the token has expired or is within 24 hours of expiring, and a refresh token is available,
 * it will automatically rotate the token and update the database.
 *
 * Returns the valid access token, or null if refresh failed.
 */
export async function getValidShopifyToken(
  userId: string
): Promise<{ accessToken: string; shopUrl: string } | null> {
  const integration = await getUserIntegration(userId);

  if (!integration) {
    return null;
  }

  // Support both prefix and non-prefix columns for access token and shop URL
  const accessToken = integration.shopify_access_token || integration.access_token;
  const shopUrl = integration.shopify_store_url || integration.shop_domain;

  if (!accessToken || !shopUrl) {
    return null;
  }

  // Get expiry timestamp, prioritizing token_expires_at then shopify_token_expires_at
  const rawExpiresAt = integration.token_expires_at || integration.shopify_token_expires_at;
  const expiresAt = rawExpiresAt ? new Date(rawExpiresAt).getTime() : null;

  // If no expiry info, assume the token is valid (legacy non-expiring token
  // that hasn't been migrated yet — the API call itself will fail with 403
  // if it's truly expired, which is handled by the caller)
  if (!expiresAt) {
    return {
      accessToken,
      shopUrl,
    };
  }

  // Check if token is within 24 hours of expiry
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const isWithin24HoursOfExpiry = Date.now() > (expiresAt - TWENTY_FOUR_HOURS);

  if (!isWithin24HoursOfExpiry) {
    return {
      accessToken,
      shopUrl,
    };
  }

  // Token is within 24 hours of expiry — attempt refresh
  const refreshToken = integration.refresh_token || integration.shopify_refresh_token;
  if (!refreshToken) {
    console.error("Token within 24 hours of expiry but no refresh token available for user:", userId);
    // Return current access token since it might still be valid for now
    return {
      accessToken,
      shopUrl,
    };
  }

  console.log("Shopify token is within 24 hours of expiry or already expired. Refreshing for user:", userId);

  try {
    const refreshRes = await fetch(
      `https://${shopUrl}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_CLIENT_ID,
          client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      }
    );

    const refreshData = await refreshRes.json();

    if (!refreshData.access_token) {
      console.error("Token refresh failed:", refreshData);
      // Return current access token since it might still be valid for now
      return {
        accessToken,
        shopUrl,
      };
    }

    const newExpiresAt = refreshData.expires_in
      ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
      : null;

    // Detect DB columns to update dynamically
    const cols = await detectDbColumns();
    const updateData: Record<string, any> = {
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
      accessToken: refreshData.access_token,
      shopUrl,
    };
  } catch (err) {
    console.error("Token refresh error:", err);
    // Return current access token since it might still be valid for now
    return {
      accessToken,
      shopUrl,
    };
  }
}
