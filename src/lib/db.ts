import { createClient } from "@supabase/supabase-js";

// Supabase client should only be instantiated inside /lib/db.ts and nowhere else in the codebase.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Get user integration record by Clerk User ID.
 */
export async function getUserIntegration(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select("*")
    .eq("clerk_user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Error in getUserIntegration:", error);
    return null;
  }
  return data;
}

/**
 * Upsert user integration record.
 */
export async function upsertUserIntegration(userId: string, data: Record<string, any>) {
  const { error } = await supabaseAdmin
    .from("user_integrations")
    .upsert(
      {
        clerk_user_id: userId,
        ...data,
      },
      { onConflict: "clerk_user_id" }
    );

  if (error) {
    console.error("Error in upsertUserIntegration:", error);
    throw error;
  }
}

/**
 * Get exchange rate cache row.
 */
export async function getExchangeRateCache() {
  const { data, error } = await supabaseAdmin
    .from("exchange_rate_cache")
    .select("rates, fetched_at")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error("Error in getExchangeRateCache:", error);
    return null;
  }
  return data;
}

/**
 * Set exchange rate cache row.
 */
export async function setExchangeRateCache(rates: Record<string, number>) {
  const { error } = await supabaseAdmin
    .from("exchange_rate_cache")
    .upsert(
      {
        id: 1,
        rates,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

  if (error) {
    console.error("Error in setExchangeRateCache:", error);
    throw error;
  }
}

/**
 * Update user credits balance.
 */
export async function updateCredits(userId: string, credits: number) {
  const { error } = await supabaseAdmin
    .from("user_integrations")
    .update({
      credits_balance: credits,
    })
    .eq("clerk_user_id", userId);

  if (error) {
    console.error("Error in updateCredits:", error);
    throw error;
  }
}

/**
 * Update user integration fields selectively (e.g. metadata, selected ad account, etc.).
 */
export async function updateUserIntegration(userId: string, data: Record<string, any>) {
  const { error } = await supabaseAdmin
    .from("user_integrations")
    .update(data)
    .eq("clerk_user_id", userId);

  if (error) {
    console.error("Error in updateUserIntegration:", error);
    throw error;
  }
}

/**
 * Delete user integration.
 */
export async function deleteUserIntegration(userId: string) {
  const { error } = await supabaseAdmin
    .from("user_integrations")
    .delete()
    .eq("clerk_user_id", userId);

  if (error) {
    console.error("Error in deleteUserIntegration:", error);
    throw error;
  }
}

/**
 * Create a new payment record.
 */
export async function createPayment(data: Record<string, any>) {
  const { data: payment, error } = await supabaseAdmin
    .from("payments")
    .insert(data)
    .select()
    .single();

  if (error) {
    console.error("Error in createPayment:", error);
    throw error;
  }
  return payment;
}

/**
 * Update a payment record.
 */
export async function updatePayment(paymentId: string, data: Record<string, any>) {
  const { error } = await supabaseAdmin
    .from("payments")
    .update(data)
    .eq("id", paymentId);

  if (error) {
    console.error("Error in updatePayment:", error);
    throw error;
  }
}

/**
 * Query user integration directly using raw supabase select structure if needed,
 * but safely abstracted.
 */
export async function queryUserIntegrationSelect(userId: string, selectQuery: string): Promise<any> {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select(selectQuery as any)
    .eq("clerk_user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Error in queryUserIntegrationSelect:", error);
    return null;
  }
  return data as any;
}

/**
 * Retrieve user integration record matched by store URL (using or operator).
 */
export async function getExistingIntegrationByStore(shopUrl: string, excludeUserId?: string) {
  let query = supabaseAdmin
    .from("user_integrations")
    .select("clerk_user_id")
    .eq("shopify_store_url", shopUrl);

  if (excludeUserId) {
    query = query.neq("clerk_user_id", excludeUserId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error("Error in getExistingIntegrationByStore:", error);
    return null;
  }
  return data;
}

/**
 * Expose direct access to detectColumns logic to preserve billing compatibility.
 */
let cachedColumns: {
  hasShopDomain: boolean;
  hasAccessToken: boolean;
  hasCredits: boolean;
  hasFreeCreditUsed: boolean;
  hasRefreshToken: boolean;
  hasTokenExpiresAt: boolean;
} | null = null;

export async function detectDbColumns() {
  if (cachedColumns) return cachedColumns;

  try {
    const { error } = await supabaseAdmin
      .from("user_integrations")
      .select("shop_domain, access_token, credits, free_credit_used, refresh_token, token_expires_at")
      .limit(1);

    if (!error) {
      cachedColumns = {
        hasShopDomain: true,
        hasAccessToken: true,
        hasCredits: true,
        hasFreeCreditUsed: true,
        hasRefreshToken: true,
        hasTokenExpiresAt: true,
      };
      return cachedColumns;
    }

    if (error.code !== "42703") {
      return {
        hasShopDomain: true,
        hasAccessToken: true,
        hasCredits: true,
        hasFreeCreditUsed: true,
        hasRefreshToken: true,
        hasTokenExpiresAt: true,
      };
    }

    const [shopRes, tokenRes, creditsRes, freeRes, refreshRes, expiresRes] = await Promise.all([
      supabaseAdmin.from("user_integrations").select("shop_domain").limit(1),
      supabaseAdmin.from("user_integrations").select("access_token").limit(1),
      supabaseAdmin.from("user_integrations").select("credits").limit(1),
      supabaseAdmin.from("user_integrations").select("free_credit_used").limit(1),
      supabaseAdmin.from("user_integrations").select("refresh_token").limit(1),
      supabaseAdmin.from("user_integrations").select("token_expires_at").limit(1),
    ]);

    const hasShopDomain = !shopRes.error || shopRes.error.code !== "42703";
    const hasAccessToken = !tokenRes.error || tokenRes.error.code !== "42703";
    const hasCredits = !creditsRes.error || creditsRes.error.code !== "42703";
    const hasFreeCreditUsed = !freeRes.error || freeRes.error.code !== "42703";
    const hasRefreshToken = !refreshRes.error || refreshRes.error.code !== "42703";
    const hasTokenExpiresAt = !expiresRes.error || expiresRes.error.code !== "42703";

    cachedColumns = {
      hasShopDomain,
      hasAccessToken,
      hasCredits,
      hasFreeCreditUsed,
      hasRefreshToken,
      hasTokenExpiresAt,
    };
    return cachedColumns;
  } catch (err) {
    console.error("Error detecting database columns:", err);
    return {
      hasShopDomain: true,
      hasAccessToken: true,
      hasCredits: true,
      hasFreeCreditUsed: true,
      hasRefreshToken: true,
      hasTokenExpiresAt: true,
    };
  }
}

/**
 * Execute dynamic select queries on user_integrations table safely.
 */
export async function selectIntegrationFieldsByShop(shop: string, selectFields: string, queryField: string): Promise<any> {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select(`clerk_user_id, ${selectFields}` as any)
    .eq(queryField, shop)
    .maybeSingle();

  if (error) {
    console.error("Error in selectIntegrationFieldsByShop:", error);
    return null;
  }
  return data as any;
}

/**
 * Update user integration selectively matched by shop domain.
 */
export async function updateIntegrationByShop(shop: string, data: Record<string, any>, queryField: string) {
  const { error } = await supabaseAdmin
    .from("user_integrations")
    .update(data)
    .eq(queryField, shop);

  if (error) {
    console.error("Error in updateIntegrationByShop:", error);
    throw error;
  }
}

/**
 * Delete all campaigns for a user.
 */
export async function deleteUserCampaigns(userId: string) {
  const { error } = await supabaseAdmin
    .from("campaigns")
    .delete()
    .eq("clerk_user_id", userId);

  if (error) {
    console.error("Error in deleteUserCampaigns:", error);
    throw error;
  }
}

/**
 * Delete all CAPI events for a user.
 */
export async function deleteUserCapiEvents(userId: string) {
  const { error } = await supabaseAdmin
    .from("capi_events")
    .delete()
    .eq("clerk_user_id", userId);

  if (error) {
    console.error("Error in deleteUserCapiEvents:", error);
    throw error;
  }
}

/**
 * Get active campaigns for a user.
 */
export async function getUserCampaigns(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .eq("clerk_user_id", userId)
    .in("status", ["active", "paused", "stopped"])
    .order("launched_at", { ascending: false });

  if (error) {
    console.error("Error in getUserCampaigns:", error);
    return [];
  }
  return data || [];
}

/**
 * Log credit usage.
 */
export async function insertCreditUsage(userId: string, creditsUsed: number, action: string) {
  const { error } = await supabaseAdmin
    .from("credit_usage")
    .insert({
      clerk_user_id: userId,
      credits_used: creditsUsed,
      action: action,
    });

  if (error) {
    console.error("Error in insertCreditUsage:", error);
    throw error;
  }
}

/**
 * Log token usage for Anthropic API calls.
 * Runs asynchronously and catches errors so it doesn't block the main thread.
 */
export async function logApiUsage(
  userId: string | null,
  feature: string,
  inputTokens: number,
  outputTokens: number
) {
  if (!userId) return;
  const totalTokens = inputTokens + outputTokens;
  
  supabaseAdmin
    .from("api_usage_log")
    .insert({
      user_id: userId,
      feature,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
    })
    .then(
      ({ error }) => {
        if (error) {
          console.error("Failed to log API usage to Supabase:", error);
        }
      },
      (err: any) => {
        console.error("Exception logging API usage:", err);
      }
    );
}
