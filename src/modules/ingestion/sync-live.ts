import "server-only";
import { shopifyGraphql } from "@/lib/connectors/shopify-graphql";
import { getShopifyAccessForShop } from "@/modules/credentials/shopify";
import type { Gql } from "./bulk";
import type { ReconcileDeps, SyncDeps } from "./sync";
import * as repo from "./sync-repository";
import { ensureSyncSubscriptions, syncWebhookEndpoint, type SubscriptionReport } from "./subscriptions";
import * as writes from "./writes";

/** The incremental sync's live dependencies: the staging or production database, and Shopify. */
async function shopGql(shopDomain: string): Promise<Gql | null> {
  const access = await getShopifyAccessForShop(shopDomain);
  if (access.status !== "ok") return null;
  return (query, variables) => shopifyGraphql(shopDomain, access.accessToken, query, variables);
}

export const liveSyncDeps = (): SyncDeps => ({ shop: repo.syncShop, gql: shopGql, repo, writes });
export const liveReconcileDeps = (): ReconcileDeps => ({ shop: repo.syncShop, gql: shopGql, repo });

/** Ensures the shop's sync subscriptions, when this environment has a public HTTPS endpoint. */
export async function ensureShopSubscriptions(shopDomain: string): Promise<SubscriptionReport | { skipped: "no_public_endpoint" | "no_access" }> {
  const endpoint = syncWebhookEndpoint();
  if (!endpoint) return { skipped: "no_public_endpoint" };
  const gql = await shopGql(shopDomain);
  if (!gql) return { skipped: "no_access" };
  return ensureSyncSubscriptions(gql, endpoint);
}
