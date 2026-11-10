import {
  detectDbColumns,
  selectIntegrationFieldsByShop,
  getUserIntegration,
  incrementCredits,
  grantFreeCredit,
  claimPayment,
  releasePayment,
  createPayment,
} from "./db";
import { getShopifyTokenForShop, getValidShopifyToken } from "./shopify-token";
import { shopifyAdminGraphqlUrl } from "./shopify-config";
import { isCreditableCharge, planForShopifyCharge, type ShopifyChargeKind } from "./shopify-billing-plans";
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
    "clerk_user_id",
    cols.hasShopDomain ? "shop_domain" : "shopify_store_url",
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

  // Tokens come only from the shop's encrypted credential (task 4).
  const mapped = mapIntegrationData(data, cols);
  const tokenRes = await getShopifyTokenForShop(shop);
  if (tokenRes.status === "ok") {
    mapped.access_token = tokenRes.accessToken;
    mapped.shop_domain = tokenRes.shopUrl;
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
    // Never the legacy plaintext column: set only from the credential service.
    access_token: null as string | null,
    credits: cols.hasCredits ? data.credits : data.credits_balance,
    free_credit_used: cols.hasFreeCreditUsed ? data.free_credit_used : false,
  };
}

/**
 * Grant purchased credits to a specific Clerk user. Atomic, and keeps both
 * balance columns in step (see incrementCredits). Callers remain responsible
 * for idempotency (e.g. `claimPayment`). Throws if the user has no integration,
 * so the caller can release its claim and retry.
 */
export async function addCreditsToUser(userId: string, creditsToAdd: number) {
  return incrementCredits(userId, creditsToAdd, creditsToAdd);
}

/** Adds the free install credit to the balance, at most once per user. */
export async function handleFreeCreditOnInstall(userId: string) {
  try {
    await grantFreeCredit(userId);
  } catch (err) {
    console.error("Failed to apply free credit:", err);
  }
}

/**
 * Grant credits to the owner of a shop (legacy charges with no recorded payer).
 * Throws when no owner is found, so the caller releases its payment claim
 * instead of silently losing the purchase.
 */
export async function addCreditsToIntegration(shop: string, creditsToAdd: number) {
  const cols = await detectColumns();
  const queryField = cols.hasShopDomain ? "shop_domain" : "shopify_store_url";
  const altField = queryField === "shop_domain" ? "shopify_store_url" : "shop_domain";

  const data =
    (await selectIntegrationFieldsByShop(shop, "credits_balance", queryField)) ??
    (await selectIntegrationFieldsByShop(shop, "credits_balance", altField));

  if (!data?.clerk_user_id) {
    throw new Error(`No integration found for shop ${shop} — cannot grant credits`);
  }
  await addCreditsToUser(data.clerk_user_id, creditsToAdd);
}

const lastBillingReconcileByUser = new Map<string, number>();
const RECONCILE_COOLDOWN_MS = 60_000;


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
            test
            createdAt
          }
          oneTimePurchases(first: 15, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                status
                test
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
      test: boolean;
      kind: ShopifyChargeKind;
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
          test: sub.test === true,
          kind: "subscription",
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
          test: node.test === true,
          kind: "one_time",
          createdAt: node.createdAt,
          amount: Number(node.price?.amount) || null,
          currency: node.price?.currencyCode || "USD",
        });
      }
    }

    for (const item of candidates) {
      // SEC-12: test charges never grant credits in production.
      if (!isCreditableCharge(item)) continue;
      const plan = planForShopifyCharge(item.name, item.kind);
      if (!plan) continue;

      const claimId = `shopify:${item.id}`;
      const claimed = await claimPayment(claimId);
      if (!claimed) continue;

      // Guard against re-crediting the manually reconciled Oct 30 KASA Starter Pack
      if (
        (userId === "user_3JsfGBNmO7sOAjbXcJ9TOwAaCEd" ||
          userId === "user_3KSNDD4EnLJdAPzQ81z0xGq4032" ||
          userId === "user_3KsRmP6KIeihqKf5DY4sHio7pPq") &&
        plan.key === "starter" &&
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
          pack: plan.key,
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
