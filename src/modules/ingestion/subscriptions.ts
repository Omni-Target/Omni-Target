import type { Gql } from "./bulk";

/**
 * The shop's incremental-sync webhook subscriptions (Phase 2, task 10), made
 * through the Admin GraphQL API so each environment registers its own endpoint
 * without touching the app's configuration. Each asks Shopify for the thin
 * fields only (includeFields), always with a field that changes per delivery,
 * because Shopify drops a delivery identical to one it sent moments before.
 */
export const SYNC_SUBSCRIPTIONS: ReadonlyArray<{ topic: string; includeFields: string[] }> = [
  { topic: "ORDERS_CREATE", includeFields: ["id", "updated_at"] },
  { topic: "ORDERS_UPDATED", includeFields: ["id", "updated_at"] },
  { topic: "ORDERS_CANCELLED", includeFields: ["id", "updated_at"] },
  { topic: "ORDERS_DELETE", includeFields: ["id"] },
  { topic: "REFUNDS_CREATE", includeFields: ["id", "order_id", "created_at"] },
  { topic: "PRODUCTS_CREATE", includeFields: ["id", "updated_at"] },
  { topic: "PRODUCTS_UPDATE", includeFields: ["id", "updated_at"] },
  { topic: "PRODUCTS_DELETE", includeFields: ["id"] },
  { topic: "CUSTOMERS_CREATE", includeFields: ["id", "updated_at"] },
  { topic: "CUSTOMERS_UPDATE", includeFields: ["id", "updated_at"] },
  { topic: "CUSTOMERS_DELETE", includeFields: ["id"] },
  { topic: "INVENTORY_LEVELS_UPDATE", includeFields: ["inventory_item_id", "location_id", "updated_at"] },
  ...["REQUEST", "APPROVE", "DECLINE", "CANCEL", "CLOSE", "REOPEN", "PROCESS", "UPDATE"].map((step) => ({
    topic: `RETURNS_${step}`, includeFields: ["admin_graphql_api_id", "status"],
  })),
];

/**
 * Lifecycle topics the webhook route handles outside the sync inbox (Phase 3, task 1): uninstall revokes access,
 * shop/update follows a renamed shop. They need the full payload (no includeFields), and are kept at the same
 * endpoint as the sync topics, so the daily reconcile repairs them too.
 */
export const LIFECYCLE_SUBSCRIPTIONS: ReadonlyArray<{ topic: string; includeFields: string[] }> = [
  { topic: "APP_UNINSTALLED", includeFields: [] },
  { topic: "SHOP_UPDATE", includeFields: [] },
];

/** Where Shopify delivers: an HTTPS base URL (SHOPIFY_WEBHOOK_BASE_URL, else the app URL), or none. */
export function syncWebhookEndpoint(env: Record<string, string | undefined> = process.env): string | null {
  const base = (env.SHOPIFY_WEBHOOK_BASE_URL || env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/\s]+/.test(base) ? `${base}/api/shopify/webhook` : null;
}

const LIST = `query SyncSubscriptions($uri: String!) {
  webhookSubscriptions(first: 100, uri: $uri) { nodes { id topic uri includeFields } }
}`;
const CREATE = `mutation CreateSyncSubscription($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) { webhookSubscription { id } userErrors { field message } }
}`;
const UPDATE = `mutation UpdateSyncSubscription($id: ID!, $subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $subscription) { webhookSubscription { id } userErrors { field message } }
}`;

export interface SubscriptionReport {
  endpoint: string;
  created: string[];
  updated: string[];
  unchanged: number;
  failed: Array<{ topic: string; error: string }>;
}

const sameFields = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
type MutationResult = { webhookSubscription: { id: string } | null; userErrors: Array<{ field?: string[] | null; message: string }> };

/** Creates what is missing at this endpoint and corrects fields that differ; never removes a subscription. */
export async function ensureSyncSubscriptions(gql: Gql, endpoint: string): Promise<SubscriptionReport> {
  const report: SubscriptionReport = { endpoint, created: [], updated: [], unchanged: 0, failed: [] };
  const existing = (await gql<{ webhookSubscriptions: { nodes: Array<{ id: string; topic: string; uri: string; includeFields: string[] }> } }>(LIST, { uri: endpoint }))
    .webhookSubscriptions.nodes.filter((node) => node.uri === endpoint);
  for (const wanted of [...SYNC_SUBSCRIPTIONS, ...LIFECYCLE_SUBSCRIPTIONS]) {
    const subscription = { uri: endpoint, format: "JSON", ...(wanted.includeFields.length ? { includeFields: wanted.includeFields } : {}) };
    const current = existing.find((node) => node.topic === wanted.topic);
    try {
      if (current && sameFields(current.includeFields ?? [], wanted.includeFields)) {
        report.unchanged += 1;
        continue;
      }
      const result = current
        ? (await gql<{ webhookSubscriptionUpdate: MutationResult }>(UPDATE, { id: current.id, subscription })).webhookSubscriptionUpdate
        : (await gql<{ webhookSubscriptionCreate: MutationResult }>(CREATE, { topic: wanted.topic, subscription })).webhookSubscriptionCreate;
      if (result.userErrors.length) throw new Error(result.userErrors.map((e) => e.message).join("; ").slice(0, 300));
      (current ? report.updated : report.created).push(wanted.topic);
    } catch (error) {
      report.failed.push({ topic: wanted.topic, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
    }
  }
  return report;
}
