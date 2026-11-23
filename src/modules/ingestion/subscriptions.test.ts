import { describe, expect, it, vi } from "vitest";
import { assertLevel1Query } from "./access";
import { CUSTOMERS_BY_ID, INVENTORY_ITEM_BY_ID, ORDER_BY_ID, PRODUCT_BY_ID, PRODUCT_METAFIELDS_PAGE, PRODUCT_VARIANTS_PAGE, RETURN_BY_ID, updatedSinceQuery } from "./queries";
import { ensureSyncSubscriptions, LIFECYCLE_SUBSCRIPTIONS, SYNC_SUBSCRIPTIONS, syncWebhookEndpoint } from "./subscriptions";
import { SYNC_TOPICS, THIN_KEYS } from "./sync-events";

const ENDPOINT = "https://app.example.com/api/shopify/webhook";

describe("sync subscriptions (task 10)", () => {
  it("delivers only to a public HTTPS endpoint", () => {
    expect(syncWebhookEndpoint({ NEXT_PUBLIC_APP_URL: "https://app.example.com/" })).toBe(ENDPOINT);
    expect(syncWebhookEndpoint({ SHOPIFY_WEBHOOK_BASE_URL: "https://tunnel.example.net", NEXT_PUBLIC_APP_URL: "https://app.example.com" })).toBe("https://tunnel.example.net/api/shopify/webhook");
    expect(syncWebhookEndpoint({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toBeNull();
    expect(syncWebhookEndpoint({})).toBeNull();
  });

  it("asks for thin fields only, with a field that changes per delivery, for every topic the worker handles", () => {
    for (const { topic, includeFields } of SYNC_SUBSCRIPTIONS) {
      expect(includeFields.every((field) => (THIN_KEYS as readonly string[]).includes(field)), topic).toBe(true);
      if (!topic.endsWith("_DELETE")) expect(includeFields.some((field) => ["updated_at", "created_at", "status"].includes(field)), topic).toBe(true);
      // INVENTORY_LEVELS_UPDATE is inventory_levels/update: the topic splits at the last underscore.
      expect(SYNC_TOPICS.has(topic.toLowerCase().replace(/_([a-z]+)$/, "/$1")), topic).toBe(true);
    }
  });

  it("creates what is missing, corrects what differs, leaves what matches, and reports what fails", async () => {
    const gql = vi.fn(async (query: string, variables: Record<string, unknown> = {}) => {
      if (query.includes("SyncSubscriptions")) {
        return { webhookSubscriptions: { nodes: [
          { id: "gid://shopify/WebhookSubscription/1", topic: "ORDERS_CREATE", uri: ENDPOINT, includeFields: ["updated_at", "id"] },
          { id: "gid://shopify/WebhookSubscription/2", topic: "PRODUCTS_UPDATE", uri: ENDPOINT, includeFields: ["id"] },
          { id: "gid://shopify/WebhookSubscription/3", topic: "ORDERS_UPDATED", uri: "https://other.example.com/hook", includeFields: ["id", "updated_at"] },
        ] } };
      }
      if (query.includes("UpdateSyncSubscription")) return { webhookSubscriptionUpdate: { webhookSubscription: { id: variables.id }, userErrors: [] } };
      const topic = variables.topic as string;
      if (topic === "RETURNS_PROCESS") return { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ["topic"], message: "Topic is not supported" }] } };
      return { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${topic}` }, userErrors: [] } };
    });
    const report = await ensureSyncSubscriptions(gql as never, ENDPOINT);
    expect(report.unchanged).toBe(1);
    expect(report.updated).toEqual(["PRODUCTS_UPDATE"]);
    expect(report.created).toContain("ORDERS_UPDATED");
    expect(report.created).not.toContain("ORDERS_CREATE");
    expect(report.failed).toEqual([{ topic: "RETURNS_PROCESS", error: "Topic is not supported" }]);
    expect(report.created.length + report.updated.length + report.unchanged + report.failed.length).toBe(SYNC_SUBSCRIPTIONS.length + LIFECYCLE_SUBSCRIPTIONS.length);
    const created = gql.mock.calls.find((call) => (call[1] as { topic?: string } | undefined)?.topic === "ORDERS_UPDATED")![1] as { subscription: unknown };
    expect(created.subscription).toEqual({ uri: ENDPOINT, format: "JSON", includeFields: ["id", "updated_at"] });
  });

  it("keeps the uninstall and shop-update topics at the same endpoint, with their full payload (Phase 3, task 1)", async () => {
    expect(LIFECYCLE_SUBSCRIPTIONS.map((s) => s.topic)).toEqual(["APP_UNINSTALLED", "SHOP_UPDATE"]);
    const gql = vi.fn(async (query: string, variables: Record<string, unknown> = {}) => {
      if (query.includes("SyncSubscriptions")) {
        // Registered at install through REST: same endpoint, all fields.
        return { webhookSubscriptions: { nodes: [{ id: "gid://shopify/WebhookSubscription/7", topic: "SHOP_UPDATE", uri: ENDPOINT, includeFields: [] }] } };
      }
      return { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${variables.topic}` }, userErrors: [] } };
    });
    const report = await ensureSyncSubscriptions(gql as never, ENDPOINT);
    expect(report.created).toContain("APP_UNINSTALLED");
    expect(report.created).not.toContain("SHOP_UPDATE");
    expect(report.updated).toEqual([]);
    const uninstall = gql.mock.calls.find((call) => (call[1] as { topic?: string } | undefined)?.topic === "APP_UNINSTALLED")![1] as { subscription: unknown };
    expect(uninstall.subscription).toEqual({ uri: ENDPOINT, format: "JSON" });
  });
});

describe("by-ID queries (task 10)", () => {
  const queries = { ORDER_BY_ID, PRODUCT_BY_ID, PRODUCT_VARIANTS_PAGE, PRODUCT_METAFIELDS_PAGE, CUSTOMERS_BY_ID, INVENTORY_ITEM_BY_ID, RETURN_BY_ID,
    updatedOrders: updatedSinceQuery("orders"), updatedProducts: updatedSinceQuery("products"), updatedCustomers: updatedSinceQuery("customers") };
  it("read Level 1 fields only, with bounded pages", () => {
    for (const [name, query] of Object.entries(queries)) {
      expect(() => assertLevel1Query(query), name).not.toThrow();
      for (const [, first] of query.matchAll(/first: (\d+)/g)) expect(Number(first), name).toBeLessThanOrEqual(250);
      if (/(lineItems|variants|metafields|inventoryLevels|returnLineItems)\(first/.test(query)) expect(query, name).toContain("pageInfo { hasNextPage endCursor }");
    }
    expect(ORDER_BY_ID).toContain("shippingAddress { city provinceCode countryCodeV2 }");
    expect(CUSTOMERS_BY_ID).not.toMatch(/email|phone|firstName|lastName|defaultAddress/);
  });
});
