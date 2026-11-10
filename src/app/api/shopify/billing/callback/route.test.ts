import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), settle: vi.fn(), reconcile: vi.fn(), currentWorkspaceFor: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: h.auth }));
vi.mock("@/modules/credits/shopify-billing", () => ({ settleShopifyReturn: h.settle, reconcileShopBilling: h.reconcile }));
vi.mock("@/modules/workspaces/current", () => ({ currentWorkspaceFor: h.currentWorkspaceFor }));

import { GET } from "./route";

const SHOP = "store.myshopify.com";
const INTENT = "11111111-1111-4111-8111-111111111111";
const call = (query: string) => GET(new Request(`https://app.test/api/shopify/billing/callback?${query}`));
const location = (r: Response) => decodeURIComponent(r.headers.get("location") ?? "");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  h.auth.mockReset().mockResolvedValue({ userId: null });
  h.settle.mockReset().mockResolvedValue({ outcome: "granted", credits: 3, plan: { label: "Starter" }, status: "ACTIVE" });
  h.reconcile.mockReset().mockResolvedValue({ grantedCredits: 0 });
  h.currentWorkspaceFor.mockReset().mockResolvedValue({ workspace_id: "ws-1", status: "active", shop_domain: SHOP });
});

describe("Shopify billing return", () => {
  it("credits through the purchase intent, with no session needed", async () => {
    const res = await call(`shop=${SHOP}&intent=${INTENT}&charge_id=123`);
    expect(location(res)).toContain("billing=success&credits=3&plan=Starter");
    expect(h.settle).toHaveBeenCalledWith(SHOP, "123", INTENT);
    expect(h.auth).not.toHaveBeenCalled();
  });

  it("ignores a uid and signature in the URL: they no longer decide anything", async () => {
    await call(`shop=${SHOP}&uid=user_attacker&sig=${"a".repeat(64)}&charge_id=123`);
    expect(h.settle).toHaveBeenCalledWith(SHOP, "123", null);
  });

  it.each([
    ["an invalid shop", `shop=evil.example.com&charge_id=123`],
    ["an invalid payment reference", `shop=${SHOP}&charge_id=1;drop`],
    ["a reference of another object type", `shop=${SHOP}&charge_id=gid://shopify/Order/1`],
    ["a malformed intent", `shop=${SHOP}&intent=not-a-uuid&charge_id=123`],
    ["missing parameters", `shop=${SHOP}`],
  ])("rejects %s without settling anything", async (_label, query) => {
    expect(location(await call(query))).toContain("billing=error");
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    [{ outcome: "duplicate", credits: 3, plan: { label: "Starter" } }, "billing=success"],
    [{ outcome: "not_creditable", status: "PENDING" }, "Status: PENDING"],
    [{ outcome: "not_creditable", status: "ACTIVE" }, "Test charges cannot be used"],
    [{ outcome: "needs_review" }, "waiting for review"],
    [{ outcome: "legacy_claimed" }, "already processed"],
    [{ outcome: "plan_mismatch" }, "couldn't verify"],
    [{ outcome: "shop_mismatch" }, "couldn't verify"],
  ])("reports %o accurately", async (result, expected) => {
    h.settle.mockResolvedValue(result);
    expect(location(await call(`shop=${SHOP}&intent=${INTENT}&charge_id=123`))).toContain(expected);
  });

  it("reconciles a return without an intent only for the signed-in owner of that shop", async () => {
    h.settle.mockResolvedValue({ outcome: "no_intent" });
    expect(location(await call(`shop=${SHOP}&charge_id=123`))).toContain("sign in");
    expect(h.reconcile).not.toHaveBeenCalled();

    h.auth.mockResolvedValue({ userId: "user_1" });
    h.currentWorkspaceFor.mockResolvedValue({ workspace_id: "ws-1", status: "active", shop_domain: "other.myshopify.com" });
    expect(location(await call(`shop=${SHOP}&charge_id=123`))).toContain("does not belong to your store");
    expect(h.reconcile).not.toHaveBeenCalled();

    h.currentWorkspaceFor.mockResolvedValue({ workspace_id: "ws-1", status: "active", shop_domain: SHOP });
    h.reconcile.mockResolvedValue({ grantedCredits: 10 });
    expect(location(await call(`shop=${SHOP}&charge_id=gid://shopify/AppSubscription/9`))).toContain("billing=success&credits=10");
    expect(h.reconcile).toHaveBeenCalledWith("user_1", "ws-1");
  });

  it("says a purchase is pending when reconciliation granted nothing", async () => {
    h.settle.mockResolvedValue({ outcome: "no_intent" });
    h.auth.mockResolvedValue({ userId: "user_1" });
    expect(location(await call(`shop=${SHOP}&charge_id=123`))).toContain("Credits are added once Shopify confirms it");
  });

  it("fails visibly when settling throws", async () => {
    h.settle.mockRejectedValue(new Error("db down"));
    expect(location(await call(`shop=${SHOP}&intent=${INTENT}&charge_id=123`))).toContain("billing=error");
  });
});
