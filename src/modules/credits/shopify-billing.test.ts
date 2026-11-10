import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  intentForCharge: vi.fn(),
  grantIntentPurchase: vi.fn(),
  recordShopPurchase: vi.fn(),
  billingStateFor: vi.fn(),
  saveBillingCursor: vi.fn(),
  tokenForShop: vi.fn(),
  tokenForWorkspace: vi.fn(),
}));
vi.mock("./ledger", () => ({
  intentForCharge: m.intentForCharge,
  grantIntentPurchase: m.grantIntentPurchase,
  recordShopPurchase: m.recordShopPurchase,
  billingStateFor: m.billingStateFor,
  saveBillingCursor: m.saveBillingCursor,
}));
vi.mock("@/lib/shopify-token", () => ({ getShopifyTokenForShop: m.tokenForShop, getValidShopifyToken: m.tokenForWorkspace }));

import { oneTimeChargeGid, reconcileShopBilling, settleShopifyReturn, type Graphql } from "./shopify-billing";

const SHOP = "store.myshopify.com";
const GID = "gid://shopify/AppPurchaseOneTime/123";
const intent = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", workspace_id: "ws-1", purchaser_clerk_user_id: "user_1",
  plan_key: "starter", credits: 3, unlimited_days: 0, status: "pending", shop_domain: SHOP, ...over,
});
const charge = (over: Record<string, unknown> = {}) => ({
  id: GID, name: "Starter Pack – 3 Credits", status: "ACTIVE", test: false, createdAt: "2026-11-10T10:00:00Z",
  price: { amount: "9.00", currencyCode: "USD" }, ...over,
});
const graphqlReturning = (node: unknown): Graphql => vi.fn(async () => ({ data: { node } }));

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const fn of Object.values(m)) fn.mockReset();
  m.intentForCharge.mockResolvedValue(intent());
  m.tokenForShop.mockResolvedValue({ status: "ok", accessToken: "token", shopUrl: SHOP });
  m.tokenForWorkspace.mockResolvedValue({ status: "ok", accessToken: "token", shopUrl: SHOP });
  m.grantIntentPurchase.mockResolvedValue({ outcome: "granted", workspace_id: "ws-1" });
  m.recordShopPurchase.mockResolvedValue({ outcome: "granted", workspace_id: "ws-1" });
  m.billingStateFor.mockResolvedValue({ shopId: "shop-1", cursor: null });
  m.saveBillingCursor.mockResolvedValue(true);
});

describe("oneTimeChargeGid", () => {
  it("accepts Shopify's numeric id or the global id, nothing else", () => {
    expect(oneTimeChargeGid("123")).toBe(GID);
    expect(oneTimeChargeGid(GID)).toBe(GID);
    expect(oneTimeChargeGid("gid://shopify/Order/1")).toBeNull();
    expect(oneTimeChargeGid("1;drop")).toBeNull();
  });
});

describe("settleShopifyReturn", () => {
  it("credits the intent's workspace after reading the charge from Shopify", async () => {
    const graphql = graphqlReturning(charge());
    const result = await settleShopifyReturn(SHOP, "123", intent().id, graphql);
    expect(result).toMatchObject({ outcome: "granted", credits: 3 });
    expect(graphql).toHaveBeenCalledWith(SHOP, "token", expect.any(String), { id: GID });
    expect(m.grantIntentPurchase).toHaveBeenCalledWith(expect.objectContaining({
      provider: "shopify", externalId: GID, planKey: "starter", creditable: true, providerStatus: "ACTIVE",
    }));
  });

  it.each([
    ["no intent exists for the charge", () => m.intentForCharge.mockResolvedValue(null), "no_intent"],
    ["the intent id in the URL is another intent's", () => m.intentForCharge.mockResolvedValue(intent({ id: "22222222-2222-4222-8222-222222222222" })), "intent_mismatch"],
    ["the intent belongs to another shop", () => m.intentForCharge.mockResolvedValue(intent({ shop_domain: "other.myshopify.com" })), "shop_mismatch"],
    ["the shop has no usable credential", () => m.tokenForShop.mockResolvedValue({ status: "reauth_required", shopUrl: SHOP }), "shop_unavailable"],
  ])("grants nothing when %s", async (_label, arrange, outcome) => {
    arrange();
    const graphql = graphqlReturning(charge());
    expect((await settleShopifyReturn(SHOP, "123", intent().id, graphql)).outcome).toBe(outcome);
    expect(m.grantIntentPurchase).not.toHaveBeenCalled();
  });

  it.each([
    ["does not exist on the shop", null, "charge_not_found"],
    ["has an unknown name", charge({ name: "Free Money Pack" }), "unrecognized_plan"],
    ["is for a different plan than the intent", charge({ name: "Scale Pack – 30 Credits" }), "plan_mismatch"],
  ])("trusts Shopify, not the URL: no credits when the charge %s", async (_label, node, outcome) => {
    expect((await settleShopifyReturn(SHOP, "123", null, graphqlReturning(node))).outcome).toBe(outcome);
    expect(m.grantIntentPurchase).not.toHaveBeenCalled();
  });

  it("reports a pending charge and a production test charge as not creditable", async () => {
    await settleShopifyReturn(SHOP, "123", null, graphqlReturning(charge({ status: "PENDING" })));
    expect(m.grantIntentPurchase).toHaveBeenLastCalledWith(expect.objectContaining({ creditable: false }));
    vi.stubEnv("NODE_ENV", "production");
    await settleShopifyReturn(SHOP, "123", null, graphqlReturning(charge({ test: true })));
    expect(m.grantIntentPurchase).toHaveBeenLastCalledWith(expect.objectContaining({ creditable: false, test: true }));
  });
});

describe("reconcileShopBilling", () => {
  const edge = (n: number, status = "ACTIVE") => ({ cursor: `c${n}`, node: charge({ id: `gid://shopify/AppPurchaseOneTime/${n}`, status }) });
  const page = (edges: unknown[], hasNextPage: boolean, activeSubscriptions: unknown[] = []) =>
    ({ data: { currentAppInstallation: { oneTimePurchases: { pageInfo: { hasNextPage }, edges }, activeSubscriptions } } });

  it("pages through the whole history from the stored cursor, moving it only from the value it read", async () => {
    m.billingStateFor.mockResolvedValue({ shopId: "shop-1", cursor: "c0" });
    const graphql = vi.fn()
      .mockResolvedValueOnce(page([edge(1), edge(2)], true))
      .mockResolvedValueOnce(page([edge(3)], false));
    const summary = await reconcileShopBilling("user_1", "ws-1", graphql);
    expect(graphql.mock.calls.map((call) => call[3])).toEqual([{ after: "c0" }, { after: "c2" }]);
    expect(m.saveBillingCursor.mock.calls).toEqual([["shop-1", "c0", "c2", false], ["shop-1", "c2", "c3", true]]);
    expect(summary).toMatchObject({ pages: 2, recorded: 3, granted: 3, grantedCredits: 9, completed: true });
  });

  it("never moves the cursor past a charge that is still pending", async () => {
    const graphql = vi.fn().mockResolvedValueOnce(page([edge(1), edge(2, "PENDING"), edge(3)], true));
    const summary = await reconcileShopBilling("user_1", "ws-1", graphql);
    expect(m.saveBillingCursor.mock.calls).toEqual([["shop-1", null, "c1", false]]);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(summary.recorded).toBe(3);
  });

  it("stops when another run moved the cursor first", async () => {
    m.saveBillingCursor.mockResolvedValue(false);
    const graphql = vi.fn().mockResolvedValue(page([edge(1)], true));
    await reconcileShopBilling("user_1", "ws-1", graphql);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("records each active subscription once per billing period", async () => {
    const sub = { id: "gid://shopify/AppSubscription/9", name: "Growth plan", status: "ACTIVE", test: false, createdAt: "2026-10-01T00:00:00Z",
      currentPeriodEnd: "2026-12-01T00:00:00Z", lineItems: [{ plan: { pricingDetails: { __typename: "AppRecurringPricing", interval: "EVERY_30_DAYS" } } }] };
    await reconcileShopBilling("user_1", "ws-1", vi.fn().mockResolvedValue(page([], false, [sub])));
    expect(m.recordShopPurchase).toHaveBeenCalledWith(expect.objectContaining({
      externalId: "gid://shopify/AppSubscription/9@2026-12-01T00:00:00Z", kind: "subscription_period",
      planKey: "growth", credits: 10, providerCreatedAt: "2026-11-01T00:00:00.000Z",
    }));
  });

  it("counts only credits granted to this workspace", async () => {
    m.recordShopPurchase.mockResolvedValue({ outcome: "granted", workspace_id: "older-workspace" });
    const summary = await reconcileShopBilling("user_1", "ws-1", vi.fn().mockResolvedValue(page([edge(1)], false)));
    expect(summary).toMatchObject({ granted: 1, grantedCredits: 0 });
  });

  it("does nothing without a usable credential", async () => {
    m.tokenForWorkspace.mockResolvedValue({ status: "not_connected" });
    const graphql = vi.fn();
    expect((await reconcileShopBilling("user_1", "ws-1", graphql)).recorded).toBe(0);
    expect(graphql).not.toHaveBeenCalled();
  });
});
