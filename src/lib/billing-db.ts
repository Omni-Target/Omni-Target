import {
  detectDbColumns,
  selectIntegrationFieldsByShop,
  updateIntegrationByShop,
  getUserIntegration,
  updateUserIntegration,
  claimPayment,
  releasePayment,
  createPayment,
} from "./db";
import { getValidShopifyToken } from "./shopify-token";
import { shopifyAdminGraphqlUrl } from "./shopify-config";
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

  const mapped = mapIntegrationData(data, cols);
  if (data.clerk_user_id) {
    const tokenRes = await getValidShopifyToken(data.clerk_user_id);
    if (tokenRes.status === "ok") {
      mapped.access_token = tokenRes.accessToken;
      mapped.shop_domain = tokenRes.shopUrl;
    }
  }
  return mapped;
}

/**
 * Fetch integration for a specific Clerk user. Preferred over
 * `getIntegrationByShop` for authenticated flows: `clerk_user_id` is unique, so
 * this never trips the PGRST116 "multiple rows" error that occurs when the same
 * Shopify store is connected under more than one app account.
 */
export async function getIntegrationByUser(userId: string) {
  const cols = await detectColumns();
  const data = await getUserIntegration(userId);
  if (!data) return null;
  const mapped = mapIntegrationData(data, cols);

  // Auto-refresh expired/expiring Shopify access tokens so billing create &
  // callback never fail with 401 when the 24h token has rotated.
  const tokenRes = await getValidShopifyToken(userId);
  if (tokenRes.status === "ok") {
    mapped.access_token = tokenRes.accessToken;
    mapped.shop_domain = tokenRes.shopUrl;
  }

  return mapped;
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
 * Grant credits to a specific Clerk user, keeping BOTH balance columns in sync.
 *
 * The schema carries a legacy `credits` column alongside `credits_balance`, and
 * every reader prefers `credits` when it exists (see /api/user/credits and the
 * generate credit gate). The `increment_credits` RPC only writes
 * `credits_balance`, so a grant made through it is invisible to the UI on this
 * schema — this helper follows the app-wide writer convention instead and
 * updates both columns (plus `credits_total_purchased` for bookkeeping).
 *
 * Callers are responsible for idempotency (e.g. `claimPayment`), which also
 * covers the read-modify-write here for the realistic replay scenario.
 */
export async function addCreditsToUser(userId: string, creditsToAdd: number) {
  const cols = await detectColumns();
  const data = await getUserIntegration(userId);
  if (!data) {
    throw new Error(`No integration row for user ${userId} — cannot grant credits`);
  }

  // Read the balance exactly the way the UI reads it.
  const currentCredits =
    (cols.hasCredits ? data.credits : data.credits_balance) ??
    data.credits_balance ??
    0;
  const newCredits = currentCredits + creditsToAdd;

  const updateData: Record<string, unknown> = {
    credits_balance: newCredits,
    credits_total_purchased:
      (data.credits_total_purchased || 0) + creditsToAdd,
  };
  if (cols.hasCredits) {
    updateData.credits = newCredits;
  }

  await updateUserIntegration(userId, updateData);
  console.log(
    `[addCreditsToUser] granted ${creditsToAdd} credits to ${userId}. New balance: ${newCredits}`
  );
  return newCredits;
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

  if (data?.clerk_user_id) {
    await addCreditsToUser(data.clerk_user_id, creditsToAdd);
    return;
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

const lastBillingReconcileByUser = new Map<string, number>();
const RECONCILE_COOLDOWN_MS = 60_000;

export function creditsForShopifyPlanName(name: string): { credits: number; planName: string } | null {
  const lower = (name || "").toLowerCase();
  if (lower.includes("starter")) return { credits: 3, planName: "Starter" };
  if (lower.includes("growth")) return { credits: 10, planName: "Growth" };
  if (lower.includes("scale")) return { credits: 30, planName: "Scale" };
  return null;
}

/**
 * Reconciles any ACTIVE Shopify one-time purchases or App Store Managed Pricing
 * subscriptions that were purchased directly in the Shopify App Store / Admin
 * (bypassing `/api/shopify/billing/callback`) or whose callback failed due to
 * an expired token.
 */
export async function reconcileShopifyBillingForUser(userId: string): Promise<void> {
  const now = Date.now();
  const lastRun = lastBillingReconcileByUser.get(userId) || 0;
  if (now - lastRun < RECONCILE_COOLDOWN_MS) return;
  lastBillingReconcileByUser.set(userId, now);

  try {
    const tokenRes = await getValidShopifyToken(userId);
    if (tokenRes.status !== "ok") return;

    const query = `
      query ReconcileAppBilling {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            createdAt
          }
          oneTimePurchases(first: 15, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                status
                createdAt
                price {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    `;

    const res = await fetch(shopifyAdminGraphqlUrl(tokenRes.shopUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": tokenRes.accessToken,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;

    const json = await res.json();
    const installation = json?.data?.currentAppInstallation;
    if (!installation) return;

    const candidates: Array<{
      id: string;
      name: string;
      status: string;
      createdAt?: string;
      amount?: number | null;
      currency?: string;
    }> = [];

    for (const sub of installation.activeSubscriptions || []) {
      if (sub?.id && sub?.status === "ACTIVE") {
        candidates.push({
          id: sub.id,
          name: sub.name || "",
          status: sub.status,
          createdAt: sub.createdAt,
          amount: null,
          currency: "USD",
        });
      }
    }

    for (const edge of installation.oneTimePurchases?.edges || []) {
      const node = edge?.node;
      if (node?.id && node?.status === "ACTIVE") {
        candidates.push({
          id: node.id,
          name: node.name || "",
          status: node.status,
          createdAt: node.createdAt,
          amount: Number(node.price?.amount) || null,
          currency: node.price?.currencyCode || "USD",
        });
      }
    }

    for (const item of candidates) {
      const plan = creditsForShopifyPlanName(item.name);
      if (!plan) continue;

      const claimId = `shopify:${item.id}`;
      const claimed = await claimPayment(claimId);
      if (!claimed) continue;

      // Guard against re-crediting the manually reconciled Oct 30 KASA Starter Pack
      if (
        (userId === "user_3JsfGBNmO7sOAjbXcJ9TOwAaCEd" ||
          userId === "user_3KSNDD4EnLJdAPzQ81z0xGq4032" ||
          userId === "user_3KsRmP6KIeihqKf5DY4sHio7pPq") &&
        plan.planName === "Starter" &&
        item.createdAt &&
        new Date(item.createdAt).getTime() <= new Date("2026-10-30T10:00:00Z").getTime()
      ) {
        const alreadyManual = !(await claimPayment("shopify:kasa-starter-613916740"));
        if (alreadyManual) {
          console.log(`[reconcileShopifyBilling] Linked ${item.id} to manual KASA Starter credit.`);
          continue;
        }
      }

      try {
        await addCreditsToUser(userId, plan.credits);
        await createPayment({
          clerk_user_id: userId,
          provider: "shopify",
          pack: plan.planName.toLowerCase(),
          amount_usd: item.amount ?? null,
          currency: item.currency || "USD",
          credits_granted: plan.credits,
          unlimited_days: 0,
          status: "success",
          provider_reference: item.id,
        }).catch(() => {});
      } catch (err) {
        await releasePayment(claimId).catch(() => {});
        console.error("[reconcileShopifyBilling] Failed to grant credits:", err);
      }
    }
  } catch (err) {
    console.warn("[reconcileShopifyBilling] Non-fatal error:", err);
  }
}
