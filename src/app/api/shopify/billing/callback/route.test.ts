import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), getIntegrationByUser: vi.fn(), addCreditsToUser: vi.fn(), claimPayment: vi.fn(), releasePayment: vi.fn(), createPayment: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: h.auth }));
vi.mock("@/lib/billing-db", () => ({ getIntegrationByUser: h.getIntegrationByUser, addCreditsToUser: h.addCreditsToUser }));
vi.mock("@/lib/db", () => ({ claimPayment: h.claimPayment, releasePayment: h.releasePayment, createPayment: h.createPayment }));

import { GET } from "./route";
import { signBillingReturn } from "@/lib/shopify-oauth";

const SHOP = "store.myshopify.com";
const charge = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/AppPurchaseOneTime/123", name: "Starter Pack – 3 Credits", status: "ACTIVE", test: false,
  price: { amount: "9.00", currencyCode: "USD" }, ...over,
});
const shopifyReturns = (oneTime: unknown) =>
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: { oneTime, subscription: null } }), { status: 200 }));
const fetchMock = vi.fn();
const call = (query: string) => GET(new Request(`https://app.test/api/shopify/billing/callback?${query}`));
const signed = (uid = "user_1", shop = SHOP) => `shop=${shop}&uid=${uid}&sig=${signBillingReturn(uid, shop)}&charge_id=123`;
const location = (r: Response) => r.headers.get("location") ?? "";

beforeEach(() => {
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", "test-secret");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock.mockReset();
  h.auth.mockReset().mockResolvedValue({ userId: null });
  h.getIntegrationByUser.mockReset().mockResolvedValue({ access_token: "t", shop_domain: SHOP });
  h.addCreditsToUser.mockReset().mockResolvedValue(4);
  h.claimPayment.mockReset().mockResolvedValue(true);
  h.releasePayment.mockReset().mockResolvedValue(undefined);
  h.createPayment.mockReset().mockResolvedValue(undefined);
  shopifyReturns(charge());
});

describe("Shopify billing return", () => {
  it("grants credits on a signed return even when the session has expired", async () => {
    const res = await call(signed());
    expect(location(res)).toContain("billing=success");
    expect(h.addCreditsToUser).toHaveBeenCalledWith("user_1", 3);
    expect(fetchMock).toHaveBeenCalledTimes(1); // verified against Shopify
  });

  it.each([
    ["a forged signature", `shop=${SHOP}&uid=user_1&sig=${"a".repeat(64)}&charge_id=123`],
    ["no signature on a claimed user", `shop=${SHOP}&uid=user_1&charge_id=123`],
    ["a signature for another user", `shop=${SHOP}&uid=user_2&sig=${"SIG"}&charge_id=123`],
    ["no user and no session", `shop=${SHOP}&charge_id=123`],
    ["an invalid shop", `shop=evil.example.com&uid=user_1&sig=x&charge_id=123`],
    ["an invalid payment reference", `shop=${SHOP}&uid=user_1&sig=x&charge_id=1;drop`],
    ["a reference of another object type", `shop=${SHOP}&uid=user_1&sig=x&charge_id=gid://shopify/Order/1`],
    ["missing parameters", `shop=${SHOP}`],
  ])("rejects %s without contacting Shopify or granting", async (_label, query) => {
    const res = await call(query.replace("SIG", signBillingReturn("user_1", SHOP)));
    expect(location(res)).toContain("billing=error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.addCreditsToUser).not.toHaveBeenCalled();
  });

  it("rejects a validly signed return for a shop the account no longer owns", async () => {
    h.getIntegrationByUser.mockResolvedValue({ access_token: "t", shop_domain: "other.myshopify.com" });
    const res = await call(signed());
    expect(location(res)).toContain("billing=error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["does not exist on the shop", null],
    ["is not active", charge({ status: "PENDING" })],
    ["has an unknown name", charge({ name: "Free Money Pack" })],
  ])("trusts Shopify, not the URL: no credits when the charge %s", async (_label, node) => {
    shopifyReturns(node);
    expect(location(await call(signed()))).toContain("billing=error");
    expect(h.addCreditsToUser).not.toHaveBeenCalled();
  });

  it("refuses a Shopify test charge in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    shopifyReturns(charge({ test: true }));
    expect(location(await call(signed()))).toContain("billing=error");
    expect(h.addCreditsToUser).not.toHaveBeenCalled();
  });

  it("does not grant twice on a replay", async () => {
    h.claimPayment.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await call(signed());
    const replay = await call(signed());
    expect(location(replay)).toContain("billing=success");
    expect(h.addCreditsToUser).toHaveBeenCalledTimes(1);
  });

  it("releases the claim if the grant fails, so a retry can succeed", async () => {
    h.addCreditsToUser.mockRejectedValue(new Error("db down"));
    expect(location(await call(signed()))).toContain("billing=error");
    expect(h.releasePayment).toHaveBeenCalledWith("shopify:gid://shopify/AppPurchaseOneTime/123");
  });

  it("accepts a Managed Pricing return from a signed-in user", async () => {
    h.auth.mockResolvedValue({ userId: "user_1" });
    expect(location(await call(`shop=${SHOP}&charge_id=123`))).toContain("billing=success");
  });
});
