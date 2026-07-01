import {
  detectDbColumns,
  selectIntegrationFieldsByShop,
  updateIntegrationByShop,
  getUserIntegration,
  updateUserIntegration,
} from "./db";
import type { UserIntegration } from "@/lib/types/integration";

export interface DBColumns {
  hasShopDomain: boolean;
  hasAccessToken: boolean;
  hasCredits: boolean;
  hasFreeCreditUsed: boolean;
  hasRefreshToken: boolean;
  hasTokenExpiresAt: boolean;
}

export async function detectColumns(): Promise<DBColumns> {
  return await detectDbColumns();
}

/**
 * Fetch integration by shop domain. Matches shop_domain or shopify_store_url.
 */
export async function getIntegrationByShop(shop: string) {
  const cols = await detectColumns();
  const selectQuery = [
    cols.hasShopDomain ? "shop_domain" : "shopify_store_url",
    cols.hasAccessToken ? "access_token" : "shopify_access_token",
    cols.hasCredits ? "credits" : "credits_balance",
    cols.hasFreeCreditUsed ? "free_credit_used" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const queryField = cols.hasShopDomain ? "shop_domain" : "shopify_store_url";

  let data = await selectIntegrationFieldsByShop(shop, selectQuery, queryField);

  if (!data) {
    // If not found, try the alternate field just in case
    const altField = queryField === "shop_domain" ? "shopify_store_url" : "shop_domain";
    data = await selectIntegrationFieldsByShop(shop, selectQuery, altField);
    if (!data) return null;
  }

  return mapIntegrationData(data, cols);
}

function mapIntegrationData(data: UserIntegration, cols: DBColumns) {
  return {
    clerk_user_id: data.clerk_user_id,
    shop_domain: cols.hasShopDomain ? data.shop_domain : data.shopify_store_url,
    access_token: cols.hasAccessToken ? data.access_token : data.shopify_access_token,
    credits: cols.hasCredits ? data.credits : data.credits_balance,
    free_credit_used: cols.hasFreeCreditUsed ? data.free_credit_used : false,
  };
}

/**
 * Handle free credits on install
 */
export async function handleFreeCreditOnInstall(userId: string) {
  const cols = await detectColumns();
  const data = await getUserIntegration(userId);

  if (!data) {
    console.error("Could not find integration to award free credits for:", userId);
    return;
  }

  const freeCreditUsed = cols.hasFreeCreditUsed ? !!data.free_credit_used : false;
  
  // If not used, update
  if (!freeCreditUsed) {
    const updateData: Record<string, unknown> = {};
    if (cols.hasCredits) {
      updateData.credits = 1;
    }
    // Always update credits_balance to be consistent
    updateData.credits_balance = 1;
    
    if (cols.hasFreeCreditUsed) {
      updateData.free_credit_used = true;
    }

    try {
      await updateUserIntegration(userId, updateData);
      console.log(`Successfully applied 1 free credit for user ${userId}`);
    } catch (updateError) {
      console.error("Failed to apply free credit:", updateError);
    }
  }
}

/**
 * Add credits to integration. Updates credits and credits_balance.
 */
export async function addCreditsToIntegration(shop: string, creditsToAdd: number) {
  const cols = await detectColumns();
  const queryField = cols.hasShopDomain ? "shop_domain" : "shopify_store_url";

  // First fetch current balance
  const selectQuery = [
    cols.hasCredits ? "credits" : "credits_balance",
    "credits_balance",
  ].join(", ");

  let data = await selectIntegrationFieldsByShop(shop, selectQuery, queryField);
  let finalQueryField = queryField;

  if (!data) {
    // Try alternate field if first lookup failed
    const altField = queryField === "shop_domain" ? "shopify_store_url" : "shop_domain";
    data = await selectIntegrationFieldsByShop(shop, selectQuery, altField);
    if (data) {
      finalQueryField = altField;
    }
  }

  let currentCredits = 0;
  if (data) {
    currentCredits = cols.hasCredits ? (data.credits || 0) : (data.credits_balance || 0);
  }

  const newCredits = currentCredits + creditsToAdd;

  const updateData: Record<string, unknown> = {};
  if (cols.hasCredits) {
    updateData.credits = newCredits;
  }
  updateData.credits_balance = newCredits;

  try {
    await updateIntegrationByShop(shop, updateData, finalQueryField);
    console.log(`Added ${creditsToAdd} credits to shop ${shop}. New total: ${newCredits}`);
  } catch (updateError) {
    console.error("Failed to add credits to integration:", updateError);
  }
}
