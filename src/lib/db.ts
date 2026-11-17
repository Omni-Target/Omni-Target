import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import type { UserIntegration } from "@/lib/types/integration";

// The client lives in src/platform/supabase.ts, behind server-only and a
// validated environment. Re-exported so existing call sites are unchanged.
export { supabaseAdmin };

/**
 * Get user integration record by Clerk User ID.
 */
export async function getUserIntegration(
  userId: string
): Promise<UserIntegration | null> {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select("*")
    .eq("clerk_user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Error in getUserIntegration:", error);
    return null;
  }
  return data as UserIntegration | null;
}

/**
 * Upsert user integration record.
 */
export async function upsertUserIntegration(userId: string, data: Record<string, unknown>) {
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
 * Update user integration fields selectively (e.g. metadata, selected ad account, etc.).
 */
export async function updateUserIntegration(userId: string, data: Record<string, unknown>) {
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
export async function createPayment(data: Record<string, unknown>) {
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
export async function updatePayment(paymentId: string, data: Record<string, unknown>) {
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
 * Fetch a single payment record by id.
 */
export async function getPaymentById(paymentId: string) {
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("*")
    .eq("id", paymentId)
    .maybeSingle();

  if (error) {
    console.error("Error in getPaymentById:", error);
    return null;
  }
  return data;
}

const isMissingRpc = (error: { code?: string }) =>
  error.code === "42883" || error.code === "PGRST202";

// Credits: every balance change goes through the workspace ledger (migration
// 0021, src/modules/credits). Nothing in this module writes a balance.

/**
 * Query user integration directly using raw supabase select structure if needed,
 * but safely abstracted.
 */
export async function queryUserIntegrationSelect(
  userId: string,
  selectQuery: string
): Promise<UserIntegration | null> {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select(selectQuery)
    .eq("clerk_user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Error in queryUserIntegrationSelect:", error);
    return null;
  }
  return data as UserIntegration | null;
}

/**
 * Retrieve user integration record matched by store URL (using or operator).
 */
function storeUrlOrFilter(shopUrl: string): string {
  const cleanShop = shopUrl
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const slug = cleanShop.replace(/\.myshopify\.com$/i, "");
  const fullShop = cleanShop.endsWith(".myshopify.com")
    ? cleanShop
    : `${cleanShop}.myshopify.com`;

  const variants = Array.from(
    new Set([cleanShop, slug, fullShop, `https://${fullShop}`, `https://${cleanShop}`])
  );

  return variants
    .flatMap((v) => [`shopify_store_url.eq.${v}`, `shop_domain.eq.${v}`])
    .join(",");
}

/**
 * Distinct Clerk users whose integration is linked to this store (at most
 * `max`). Used by the Shopify OAuth callback to decide whether a signed-out
 * "Continue with Shopify" maps to exactly one account. Throws on database
 * errors so the caller fails closed instead of treating them as "no account".
 */
export async function getUserIdsLinkedToStore(shopUrl: string, max = 2): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select("clerk_user_id")
    .or(storeUrlOrFilter(shopUrl))
    .limit(25);

  if (error) {
    throw new Error(`Store link lookup failed: ${error.code || error.message}`);
  }
  const ids = new Set<string>();
  for (const row of data || []) {
    if (row?.clerk_user_id) ids.add(String(row.clerk_user_id));
    if (ids.size >= max) break;
  }
  return [...ids];
}

export async function getExistingIntegrationByStore(shopUrl: string, excludeUserId?: string) {
  const orFilter = storeUrlOrFilter(shopUrl);

  let query = supabaseAdmin
    .from("user_integrations")
    .select("clerk_user_id, shopify_store_url, shop_domain")
    .or(orFilter);

  if (excludeUserId) {
    query = query.neq("clerk_user_id", excludeUserId);
  }

  const { data, error } = await query.limit(1).maybeSingle();

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
export async function selectIntegrationFieldsByShop(shop: string, selectFields: string, queryField: string): Promise<UserIntegration | null> {
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select(`clerk_user_id, ${selectFields}`)
    .eq(queryField, shop)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error in selectIntegrationFieldsByShop:", error);
    return null;
  }
  return (Array.isArray(data) ? data[0] ?? null : data) as unknown as UserIntegration | null;
}

/**
 * Update user integration selectively matched by shop domain.
 */
export async function updateIntegrationByShop(shop: string, data: Record<string, unknown>, queryField: string) {
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
 * GDPR `shop/redact`: erase the Shopify-scoped data held for a shop (OAuth
 * tokens + cached store snapshot) without touching the user's Meta connection
 * or credits — the integration row is shared across providers, so we clear
 * fields rather than deleting the row.
 *
 * Never throws (the webhook must acknowledge with 200 regardless); returns
 * `true` on success, `false` if the update errored.
 */
export async function redactShopData(shop: string): Promise<boolean> {
  const { error } = await supabaseAdmin.rpc("redact_shop_data", { p_shop: shop });
  if (!error) return true;
  if (!isMissingRpc(error)) {
    console.error("[redact_shop_data] failed:", error.message);
    return false;
  }
  console.error("[redact_shop_data] missing — apply migration 0016.");
  return clearShopCredentials(shop, true);
}

/**
 * app/uninstalled: revokes stored credentials and stops syncing. Operational
 * only; shop data stays until Shopify sends shop/redact 48 hours later.
 */
export async function disconnectShopInstallation(shop: string): Promise<boolean> {
  const { error } = await supabaseAdmin.rpc("disconnect_shop_installation", { p_shop: shop });
  if (!error) return true;
  if (!isMissingRpc(error)) {
    console.error("[disconnect_shop_installation] failed:", error.message);
    return false;
  }
  console.error("[disconnect_shop_installation] missing — apply migration 0016.");
  return clearShopCredentials(shop, false);
}

async function clearShopCredentials(shop: string, clearSnapshot: boolean): Promise<boolean> {
  const cols = await detectDbColumns();
  const payload: Record<string, null> = {
    shopify_access_token: null,
    shopify_refresh_token: null,
    shopify_token_expires_at: null,
  };
  if (cols.hasAccessToken) payload.access_token = null;
  if (cols.hasRefreshToken) payload.refresh_token = null;
  if (cols.hasTokenExpiresAt) payload.token_expires_at = null;
  if (clearSnapshot) payload.store_snapshot = null;

  const { error } = await supabaseAdmin
    .from("user_integrations")
    .update(payload)
    .or(storeUrlOrFilter(shop));
  if (error) {
    console.error("[clearShopCredentials] failed:", error.message);
    return false;
  }
  return true;
}

/** Removes one account's data from every table (migration 0016). */
export async function deleteUserData(userId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("delete_user_data", { p_user_id: userId });
  if (error) throw error;
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


// --- Brief persistence & versioning (perf/reliability initiative) -----------
// A `campaigns` row is one brief session; `campaign_brief_versions` holds each
// generation attempt (initial + up to 3 free regenerations). Exactly one version
// per campaign carries is_selected = true — the variation the user kept. Every
// function is scoped by clerk_user_id so a spoofed id can't reach another user's
// data.

export interface BriefCopyFields {
  headline?: string | null;
  primary_text?: string | null;
  description?: string | null;
  cta?: string | null;
  copywriter_note?: string | null;
}

export interface CampaignInsert extends BriefCopyFields {
  brand_name?: string | null;
  product_name?: string | null;
  product_description?: string | null;
  target_audience?: string | null;
  campaign_goal?: string | null;
  tone_preference?: string | null;
  platform?: string | null;
  media_url?: string | null;
  product_price?: string | null;
  brief_data?: Record<string, unknown> | null;
}








/** Record every billed token category, including prompt-cache reads and writes. */
export async function logApiUsage(
  userId: string | null,
  feature: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
  model: string,
) {
  if (!userId) return;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  try {
    const { error } = await supabaseAdmin.from("api_usage_log").insert({
      user_id: userId,
      feature,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
      total_tokens: usage.input_tokens + cacheCreation + cacheRead + usage.output_tokens,
    });
    if (error) console.error("Failed to log API usage to Supabase:", error);
  } catch (error) {
    console.error("Exception logging API usage:", error);
  }
}



/** Stop regenerations before model calls when the atomic save fix is not deployed. */
export async function isBriefRegenerationCommitReady(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("schema_migrations")
    .select("id")
    .eq("id", "0010_fix_commit_brief_ambiguity")
    .maybeSingle();
  if (error) {
    console.error("Could not verify brief regeneration migration:", error.message, error.code);
    return false;
  }
  return data?.id === "0010_fix_commit_brief_ambiguity";
}

export async function commitBriefGeneration(params: {
  p_workspace: string; p_user_id: string; p_request_id: string; p_request_hash: string; p_campaign_id: string | null;
  p_campaign: Record<string, unknown>; p_copy: Record<string, unknown>;
  p_context: Record<string, unknown>; p_response: Record<string, unknown>;
}) {
  const { data, error } = await supabaseAdmin.rpc("commit_brief_generation", params);
  if (!error && data && typeof data === "object" && "campaignId" in data && "versionId" in data) {
    return data;
  }
  if (!error) {
    console.error("commit_brief_generation returned an incomplete receipt");
    throw new Error("Could not confirm the brief was saved. Please retry.");
  }

  // Known intentional business validation exceptions from the RPC
  const knownBusinessErrors = [
    "no_credits",
    "regeneration_limit",
    "regeneration_product_changed",
    "invalid_regeneration",
    "idempotency_conflict",
    "workspace_inactive",
    "workspace_access_denied",
  ];
  if (knownBusinessErrors.includes(error.message)) {
    throw new Error(error.message);
  }

  // The RPC owns credit deduction, campaign/version writes, and the receipt in
  // one database transaction. A multi-request fallback cannot preserve those
  // guarantees, so surface the failure without reporting a successful charge.
  console.error("commit_brief_generation failed:", error.message, error.code);
  throw new Error("Could not confirm the brief was saved. Please retry.");
}


