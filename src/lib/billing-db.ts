import { supabaseAdmin } from "./supabase";

export interface DBColumns {
  hasShopDomain: boolean;
  hasAccessToken: boolean;
  hasCredits: boolean;
  hasFreeCreditUsed: boolean;
}

let cachedColumns: DBColumns | null = null;

export async function detectColumns(): Promise<DBColumns> {
  if (cachedColumns) return cachedColumns;

  try {
    const { error } = await supabaseAdmin
      .from("user_integrations")
      .select("shop_domain, access_token, credits, free_credit_used")
      .limit(1);

    if (!error) {
      cachedColumns = {
        hasShopDomain: true,
        hasAccessToken: true,
        hasCredits: true,
        hasFreeCreditUsed: true,
      };
      return cachedColumns;
    }

    // Detect individually
    const [shopRes, tokenRes, creditsRes, freeRes] = await Promise.all([
      supabaseAdmin.from("user_integrations").select("shop_domain").limit(1),
      supabaseAdmin.from("user_integrations").select("access_token").limit(1),
      supabaseAdmin.from("user_integrations").select("credits").limit(1),
      supabaseAdmin.from("user_integrations").select("free_credit_used").limit(1),
    ]);

    cachedColumns = {
      hasShopDomain: !shopRes.error,
      hasAccessToken: !tokenRes.error,
      hasCredits: !creditsRes.error,
      hasFreeCreditUsed: !freeRes.error,
    };
    return cachedColumns;
  } catch (err) {
    console.error("Error detecting database columns:", err);
    return {
      hasShopDomain: false,
      hasAccessToken: false,
      hasCredits: false,
      hasFreeCreditUsed: false,
    };
  }
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

  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select(`clerk_user_id, ${selectQuery}`)
    .eq(queryField, shop)
    .single() as any;

  if (error || !data) {
    // If not found, try the alternate field just in case
    const altField = queryField === "shop_domain" ? "shopify_store_url" : "shop_domain";
    const { data: altData, error: altError } = await supabaseAdmin
      .from("user_integrations")
      .select(`clerk_user_id, ${selectQuery}`)
      .eq(altField, shop)
      .single() as any;

    if (altError || !altData) return null;
    return mapIntegrationData(altData, cols);
  }

  return mapIntegrationData(data, cols);
}

function mapIntegrationData(data: any, cols: DBColumns) {
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
  
  // Fetch existing state
  const selectQuery = [
    cols.hasCredits ? "credits" : "credits_balance",
    cols.hasFreeCreditUsed ? "free_credit_used" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select(selectQuery)
    .eq("clerk_user_id", userId)
    .single() as any;

  if (error || !data) {
    console.error("Could not find integration to award free credits:", error);
    return;
  }

  const freeCreditUsed = cols.hasFreeCreditUsed ? !!data.free_credit_used : false;
  
  // If not used, update
  if (!freeCreditUsed) {
    const updateData: Record<string, any> = {};
    if (cols.hasCredits) {
      updateData.credits = 1;
    }
    // Always update credits_balance to be consistent
    updateData.credits_balance = 1;
    
    if (cols.hasFreeCreditUsed) {
      updateData.free_credit_used = true;
    }

    const { error: updateError } = await supabaseAdmin
      .from("user_integrations")
      .update(updateData)
      .eq("clerk_user_id", userId);

    if (updateError) {
      console.error("Failed to apply free credit:", updateError);
    } else {
      console.log(`Successfully applied 1 free credit for user ${userId}`);
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

  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select(selectQuery)
    .eq(queryField, shop)
    .single() as any;

  let currentCredits = 0;
  if (!error && data) {
    currentCredits = cols.hasCredits ? (data.credits || 0) : (data.credits_balance || 0);
  } else {
    // Try alternate field if first lookup failed
    const altField = queryField === "shop_domain" ? "shopify_store_url" : "shop_domain";
    const { data: altData } = await supabaseAdmin
      .from("user_integrations")
      .select(selectQuery)
      .eq(altField, shop)
      .single() as any;
    if (altData) {
      currentCredits = cols.hasCredits ? (altData.credits || 0) : (altData.credits_balance || 0);
    }
  }

  const newCredits = currentCredits + creditsToAdd;

  const updateData: Record<string, any> = {};
  if (cols.hasCredits) {
    updateData.credits = newCredits;
  }
  updateData.credits_balance = newCredits;

  const { error: updateError } = await supabaseAdmin
    .from("user_integrations")
    .update(updateData)
    .eq(queryField, shop);

  if (updateError) {
    // Try alternate field if update failed
    const altField = queryField === "shop_domain" ? "shopify_store_url" : "shop_domain";
    await supabaseAdmin
      .from("user_integrations")
      .update(updateData)
      .eq(altField, shop);
  }

  console.log(`Added ${creditsToAdd} credits to shop ${shop}. New total: ${newCredits}`);
}
