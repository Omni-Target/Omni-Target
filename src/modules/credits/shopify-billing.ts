import "server-only";
import { createLogger } from "@/platform/logger";
import { shopifyAdminGraphqlUrl } from "@/lib/shopify-config";
import { getShopifyTokenForShop, getValidShopifyToken } from "@/lib/shopify-token";
import { isCreditableCharge, planForShopifyCharge, type ShopifyCreditPlan } from "@/lib/shopify-billing-plans";
import {
  billingStateFor,
  grantIntentPurchase,
  intentForCharge,
  recordShopPurchase,
  saveBillingCursor,
  type PurchaseOutcome,
} from "./ledger";

/**
 * Shopify purchases (Phase 1, task 5). A one-time purchase is credited to the
 * workspace and purchaser recorded in its intent when the merchant returns
 * from Shopify. Reconciliation pages through the shop's whole purchase history
 * from a durable cursor and records every charge; a charge without an intent
 * is credited only through an unambiguous binding period, never to whoever
 * happens to load the page. No database transaction spans a Shopify call.
 */

const log = createLogger({ module: "shopify-billing" });

export type Graphql = (shop: string, token: string, query: string, variables?: Record<string, unknown>) => Promise<unknown>;

const graphqlFetch: Graphql = async (shop, token, query, variables) => {
  const res = await fetch(shopifyAdminGraphqlUrl(shop), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`shopify_http_${res.status}`);
  return res.json();
};

/** Shopify's return carries a numeric id; intents store the global id. */
export function oneTimeChargeGid(chargeId: string): string | null {
  const numeric = chargeId.match(/^(?:gid:\/\/shopify\/AppPurchaseOneTime\/)?(\d+)$/)?.[1];
  return numeric ? `gid://shopify/AppPurchaseOneTime/${numeric}` : null;
}

const CHARGE_QUERY = `query Charge($id: ID!) {
  node(id: $id) { ... on AppPurchaseOneTime { id name status test createdAt price { amount currencyCode } } }
}`;

interface OneTimeCharge {
  id: string;
  name: string;
  status: string;
  test: boolean;
  createdAt: string;
  price?: { amount: string; currencyCode: string } | null;
}

export type ReturnOutcome =
  | PurchaseOutcome
  | "invalid_charge"
  | "intent_mismatch"
  | "shop_mismatch"
  | "shop_unavailable"
  | "charge_not_found"
  | "unrecognized_plan"
  | "plan_mismatch";

export interface ReturnResult {
  outcome: ReturnOutcome;
  credits?: number;
  plan?: ShopifyCreditPlan;
  status?: string;
}

/**
 * Settles a merchant's return from Shopify billing. The charge is read from
 * Shopify with the shop's own credential; credits go to the intent's workspace.
 * A return without an intent (Managed Pricing, or a link from before intents)
 * is left to reconciliation.
 */
export async function settleShopifyReturn(
  shop: string,
  chargeId: string,
  intentId: string | null,
  graphql: Graphql = graphqlFetch,
): Promise<ReturnResult> {
  const gid = oneTimeChargeGid(chargeId);
  if (!gid) return { outcome: "invalid_charge" };
  const intent = await intentForCharge("shopify", gid);
  if (!intent) return { outcome: "no_intent" };
  if (intentId && intent.id !== intentId) return { outcome: "intent_mismatch" };
  if (intent.shop_domain !== shop.toLowerCase()) return { outcome: "shop_mismatch" };

  const token = await getShopifyTokenForShop(intent.shop_domain);
  if (token.status !== "ok") return { outcome: "shop_unavailable" };
  const response = (await graphql(token.shopUrl, token.accessToken, CHARGE_QUERY, { id: gid })) as { data?: { node?: OneTimeCharge | null } };
  const charge = response?.data?.node;
  if (!charge?.id) return { outcome: "charge_not_found" };

  const plan = planForShopifyCharge(charge.name, "one_time");
  if (!plan) return { outcome: "unrecognized_plan", status: charge.status };
  if (plan.key !== intent.plan_key) return { outcome: "plan_mismatch", status: charge.status };

  const result = await grantIntentPurchase({
    provider: "shopify",
    externalId: gid,
    planKey: plan.key,
    providerStatus: charge.status,
    test: charge.test === true,
    creditable: isCreditableCharge(charge),
    amount: charge.price ? Number(charge.price.amount) : null,
    currency: charge.price?.currencyCode ?? null,
    providerCreatedAt: charge.createdAt ?? null,
    details: { name: charge.name },
  });
  return { outcome: result.outcome, credits: intent.credits, plan, status: charge.status };
}

const PURCHASES_QUERY = `query Purchases($after: String) {
  currentAppInstallation {
    oneTimePurchases(first: 25, after: $after, sortKey: CREATED_AT) {
      pageInfo { hasNextPage }
      edges { cursor node { id name status test createdAt price { amount currencyCode } } }
    }
    activeSubscriptions {
      id name status test createdAt currentPeriodEnd
      lineItems { plan { pricingDetails { __typename ... on AppRecurringPricing { interval } } } }
    }
  }
}`;

interface PurchasesPage {
  data?: {
    currentAppInstallation?: {
      oneTimePurchases?: { pageInfo: { hasNextPage: boolean }; edges: { cursor: string; node: OneTimeCharge }[] };
      activeSubscriptions?: {
        id: string; name: string; status: string; test: boolean; createdAt: string; currentPeriodEnd: string | null;
        lineItems?: { plan?: { pricingDetails?: { __typename?: string; interval?: string } } }[];
      }[];
    } | null;
  };
}

/** A charge's status will not change again, so the cursor may move past it. */
const FINAL_STATUSES = new Set(["ACTIVE", "DECLINED", "EXPIRED", "CANCELLED"]);
const MAX_PAGES_PER_RUN = 8;
const DAY_MS = 86_400_000;

export interface ReconcileSummary {
  pages: number;
  recorded: number;
  granted: number;
  grantedCredits: number;
  completed: boolean;
}

/**
 * Pages through every one-time purchase of the workspace's shop (oldest first,
 * resuming from the stored cursor) and records each active subscription's
 * current period. Recording is idempotent; the cursor only moves past charges
 * in a final state and only from the value this run read.
 */
export async function reconcileShopBilling(
  userId: string,
  workspaceId: string,
  graphql: Graphql = graphqlFetch,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { pages: 0, recorded: 0, granted: 0, grantedCredits: 0, completed: false };
  const token = await getValidShopifyToken(userId, workspaceId);
  if (token.status !== "ok") return summary;
  const state = await billingStateFor(token.shopUrl);
  if (!state) return summary;

  let cursor = state.cursor;
  let subscriptionsDone = false;
  while (summary.pages < MAX_PAGES_PER_RUN) {
    const page = (await graphql(token.shopUrl, token.accessToken, PURCHASES_QUERY, { after: cursor })) as PurchasesPage;
    const installation = page?.data?.currentAppInstallation;
    if (!installation?.oneTimePurchases) break;
    summary.pages++;

    if (!subscriptionsDone) {
      subscriptionsDone = true;
      for (const sub of installation.activeSubscriptions ?? []) {
        if (sub.status !== "ACTIVE" || !sub.currentPeriodEnd) continue;
        const interval = sub.lineItems?.[0]?.plan?.pricingDetails?.interval;
        const periodStart = new Date(Date.parse(sub.currentPeriodEnd) - (interval === "ANNUAL" ? 365 : 30) * DAY_MS).toISOString();
        const plan = planForShopifyCharge(sub.name, "subscription");
        const result = await recordShopPurchase({
          shopId: state.shopId, externalId: `${sub.id}@${sub.currentPeriodEnd}`, kind: "subscription_period",
          planKey: plan?.key ?? null, credits: plan?.credits ?? 0, providerStatus: sub.status, test: sub.test === true,
          creditable: Boolean(plan) && isCreditableCharge(sub), amount: null, currency: null,
          providerCreatedAt: periodStart, details: { name: sub.name, subscription: sub.id, interval: interval ?? null },
        });
        summary.recorded++;
        if (result.outcome === "granted") {
          summary.granted++;
          if (result.workspace_id === workspaceId) summary.grantedCredits += plan?.credits ?? 0;
        }
      }
    }

    let advanceTo = cursor;
    let blocked = false;
    for (const { cursor: edgeCursor, node } of installation.oneTimePurchases.edges) {
      const plan = planForShopifyCharge(node.name, "one_time");
      const result = await recordShopPurchase({
        shopId: state.shopId, externalId: node.id, kind: "one_time", planKey: plan?.key ?? null,
        credits: plan?.credits ?? 0, providerStatus: node.status, test: node.test === true,
        creditable: Boolean(plan) && isCreditableCharge(node),
        amount: node.price ? Number(node.price.amount) : null, currency: node.price?.currencyCode ?? null,
        providerCreatedAt: node.createdAt ?? null, details: { name: node.name },
      });
      summary.recorded++;
      if (result.outcome === "granted") {
        summary.granted++;
        if (result.workspace_id === workspaceId) summary.grantedCredits += plan?.credits ?? 0;
      }
      if (!blocked && FINAL_STATUSES.has(node.status)) advanceTo = edgeCursor;
      else blocked = true; // A pending charge is revisited next run, so the cursor stops before it.
    }

    const hasNext = installation.oneTimePurchases.pageInfo.hasNextPage;
    const completed = !hasNext && !blocked;
    if (advanceTo !== cursor || completed) {
      if (!(await saveBillingCursor(state.shopId, cursor, advanceTo, completed))) {
        log.info("Another reconciliation moved the billing cursor; stopping this run", { shopId: state.shopId });
        break;
      }
    }
    cursor = advanceTo;
    summary.completed = completed;
    if (!hasNext || blocked) break;
  }
  return summary;
}

const lastRun = new Map<string, number>();
const COOLDOWN_MS = 60_000;

/** Reconciliation from a page load: at most once a minute per workspace, never throwing. */
export async function reconcileWorkspaceBilling(userId: string, workspaceId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastRun.get(workspaceId) ?? 0) < COOLDOWN_MS) return;
  lastRun.set(workspaceId, now);
  try {
    const summary = await reconcileShopBilling(userId, workspaceId);
    if (summary.recorded) log.info("Reconciled Shopify purchases", { workspaceId, ...summary });
  } catch (error) {
    log.warn("Shopify billing reconciliation failed", { workspaceId }, error);
  }
}
