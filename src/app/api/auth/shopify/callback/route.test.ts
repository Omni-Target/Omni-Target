import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOAuthState } from "@/lib/shopify-oauth";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
  getUserList: vi.fn(),
  createUser: vi.fn(),
  createSignInToken: vi.fn(),
  getUserIdsLinkedToStore: vi.fn(),
  upsertUserIntegration: vi.fn(),
  updateUserIntegration: vi.fn(),
  getUserIntegration: vi.fn(),
  grantFreeCredit: vi.fn(),
  fetchWithRetry: vi.fn(),
  sendEmail: vi.fn(),
  disconnectShopInstallation: vi.fn(),
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  leaseHeld: vi.fn(),
  check: vi.fn(),
  commit: vi.fn(),
  shopOwner: vi.fn(),
  transferForRequester: vi.fn(),
  verifyTransfer: vi.fn(),
  seal: vi.fn(),
}));

vi.mock("@/modules/workspaces/repository", () => ({
  acquireInstallLease: m.acquireLease,
  releaseInstallLease: m.releaseLease,
  installLeaseHeld: m.leaseHeld,
  connectCheckUnderLease: m.check,
  commitShopInstallUnderLease: m.commit,
  shopOwner: m.shopOwner,
  transferForRequester: m.transferForRequester,
  verifyOwnershipTransfer: m.verifyTransfer,
}));
vi.mock("@/modules/credentials/shopify", () => ({ sealShopCredential: m.seal }));
vi.mock("@/modules/workspaces/current", () => ({
  workspaceCookie: (id: string) => `omnitarget_workspace=${id}; Path=/; HttpOnly`,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: m.auth,
  clerkClient: async () => ({
    users: {
      getUser: m.getUser,
      updateUserMetadata: m.updateUserMetadata,
      getUserList: m.getUserList,
      createUser: m.createUser,
    },
    signInTokens: { createSignInToken: m.createSignInToken },
  }),
}));
vi.mock("@/lib/db", () => ({
  getUserIdsLinkedToStore: m.getUserIdsLinkedToStore,
  upsertUserIntegration: m.upsertUserIntegration,
  updateUserIntegration: m.updateUserIntegration,
  getUserIntegration: m.getUserIntegration,
  disconnectShopInstallation: m.disconnectShopInstallation,
}));
vi.mock("@/modules/credits/ledger", () => ({ grantFreeCredit: m.grantFreeCredit }));
vi.mock("@/lib/http", () => ({ fetchWithRetry: m.fetchWithRetry }));
vi.mock("@/lib/shopify-store-logo", () => ({ fetchShopifyStoreLogo: vi.fn(async () => null) }));
vi.mock("@/lib/email", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/emails/welcome", () => ({ welcomeEmailHtml: () => "<p>welcome</p>" }));

import { GET } from "./route";

const SECRET = "test-shopify-client-secret";
const SHOP = "attacker-store.myshopify.com";
const APP = "https://app.test";

function signedCallback(opts: { state: string; cookie?: string; timestamp?: number; tamper?: boolean }) {
  const params: Record<string, string> = {
    code: "auth-code-1",
    shop: SHOP,
    state: opts.state,
    timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
  };
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = createHmac("sha256", SECRET).update(message).digest("hex");
  const query = new URLSearchParams({ ...params, hmac });
  if (opts.tamper) query.set("state", `${opts.state}x`);
  return new Request(`${APP}/api/auth/shopify/callback?${query}`, {
    headers: opts.cookie ? { cookie: opts.cookie } : {},
  });
}

function stateCookie(
  input: { from?: "signup" | "login" | "onboarding" | "app_store" | "dashboard"; uid?: string | null; ws?: string; tr?: string } = {},
) {
  const { nonce, cookieValue } = createOAuthState({
    shop: SHOP,
    from: input.from ?? "signup",
    plan: "",
    initiatorUserId: input.uid ?? null,
    workspaceId: input.ws ?? null,
    transferId: input.tr ?? null,
  });
  return { nonce, cookie: `shopify_oauth_state=${encodeURIComponent(cookieValue)}` };
}

function setCookies(response: Response): string[] {
  const h = response.headers as Headers & { getSetCookie?: () => string[] };
  return h.getSetCookie ? h.getSetCookie() : [h.get("set-cookie") || ""];
}

beforeEach(() => {
  process.env.SHOPIFY_CLIENT_SECRET = SECRET;
  process.env.SHOPIFY_CLIENT_ID = "client-id";
  process.env.NEXT_PUBLIC_APP_URL = APP;
  for (const fn of Object.values(m)) fn.mockReset();
  m.auth.mockResolvedValue({ userId: null });
  m.getUserIdsLinkedToStore.mockResolvedValue([]);
  m.grantFreeCredit.mockResolvedValue("already_granted");
  m.getUserIntegration.mockResolvedValue({ free_credit_used: true });
  m.getUser.mockResolvedValue({ publicMetadata: { onboardingStep: "complete" } });
  m.createSignInToken.mockResolvedValue({ token: "ticket-123" });
  m.getUserList.mockResolvedValue({ data: [{ id: "user_victim" }] });
  m.acquireLease.mockResolvedValue("holder-1");
  m.releaseLease.mockResolvedValue(undefined);
  m.leaseHeld.mockResolvedValue(true);
  m.check.mockResolvedValue("allowed");
  m.commit.mockResolvedValue({ outcome: "bound_new_workspace", workspace_id: "ws-new" });
  m.shopOwner.mockResolvedValue(null);
  m.seal.mockImplementation((shopId: number) => ({ sealed: true, shopId }));
  m.disconnectShopInstallation.mockResolvedValue(true);
  m.transferForRequester.mockResolvedValue(null);
  m.fetchWithRetry.mockResolvedValue(
    Response.json({ access_token: "shpat_test", refresh_token: "shprt_test", expires_in: 3600, scope: "read_products" }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("shop.json")) {
        // The shop's contact email deliberately matches an existing account.
        return Response.json({ shop: { id: 548380009, email: "victim@example.com", myshopify_domain: SHOP, name: "Attacker", domain: null } });
      }
      if (url.includes("webhooks.json")) return Response.json({ webhook: { id: 99 } });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shopify OAuth callback — SEC-01 account takeover regressions", () => {
  it("never signs anyone in from a forged state naming a victim (no state cookie)", async () => {
    const res = await GET(signedCallback({ state: "deadbeef___signup___user_victim___" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`${APP}/signup?error=shopify_auth_failed`);
    expect(m.createSignInToken).not.toHaveBeenCalled();
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
    expect(m.fetchWithRetry).not.toHaveBeenCalled();
    expect(m.getUserIdsLinkedToStore).not.toHaveBeenCalled();
  });

  it("does not link or sign in by the shop's contact email, and never creates accounts", async () => {
    const { nonce, cookie } = stateCookie({ from: "app_store" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}/signup?pending=shopify`);
    expect(setCookies(res).some((c) => c.startsWith("shopify_pending_install=") && !c.includes("Max-Age=0"))).toBe(true);
    expect(m.getUserList).not.toHaveBeenCalled();
    expect(m.createUser).not.toHaveBeenCalled();
    expect(m.createSignInToken).not.toHaveBeenCalled();
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
    expect(m.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("refuses to finish a flow when the session changed after it started", async () => {
    m.auth.mockResolvedValue({ userId: "user_b" });
    const { nonce, cookie } = stateCookie({ from: "onboarding", uid: "user_a" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.headers.get("location")).toContain("error=shopify_auth_failed");
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });

  it("rejects a callback whose state does not match this browser's cookie", async () => {
    const { cookie } = stateCookie();
    const res = await GET(signedCallback({ state: "0".repeat(64), cookie }));
    expect(res.headers.get("location")).toContain("error=shopify_auth_failed");
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });
});

describe("Shopify OAuth callback — legitimate flows", () => {
  it("links the store to the authenticated session that started the flow", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    const { nonce, cookie } = stateCookie({ from: "onboarding", uid: "user_a" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}/dashboard`);
    expect(m.upsertUserIntegration).toHaveBeenCalledWith("user_a", expect.objectContaining({ shopify_store_url: SHOP }));
    expect(m.createSignInToken).not.toHaveBeenCalled();
    // State cookie is single-use.
    expect(setCookies(res).some((c) => c.startsWith("shopify_oauth_state=;") && c.includes("Max-Age=0"))).toBe(true);
  });

  it("signed-out Continue with Shopify for a store linked to exactly one account signs in that account", async () => {
    m.getUserIdsLinkedToStore.mockResolvedValue(["user_a"]);
    const { nonce, cookie } = stateCookie({ from: "login" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(m.getUserIdsLinkedToStore).toHaveBeenCalledWith(SHOP);
    expect(m.createSignInToken).toHaveBeenCalledWith({ userId: "user_a", expiresInSeconds: 300 });
    expect(m.upsertUserIntegration).toHaveBeenCalledWith("user_a", expect.any(Object));
    expect(res.headers.get("location")).toBe(`${APP}/auth/shopify-callback?token=ticket-123&destination=%2Fdashboard`);
  });

  it("a store linked to several accounts requires an explicit sign-in", async () => {
    m.getUserIdsLinkedToStore.mockResolvedValue(["user_a", "user_b"]);
    const { nonce, cookie } = stateCookie({ from: "login" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.headers.get("location")).toBe(`${APP}/login?pending=shopify&reason=multiple_accounts`);
    expect(m.createSignInToken).not.toHaveBeenCalled();
  });

  it("fails closed when the store-link lookup errors", async () => {
    m.getUserIdsLinkedToStore.mockRejectedValue(new Error("db down"));
    const { nonce, cookie } = stateCookie({ from: "login" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.headers.get("location")).toContain(`${APP}/login?error=shopify_auth_failed`);
    expect(m.createSignInToken).not.toHaveBeenCalled();
  });
});

describe("Shopify OAuth callback — workspace ownership (Phase 1 task 3)", () => {
  const WS = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  const TR = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

  it("takes the shop's lease, checks ownership under it, then binds by Shopify's shop id", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    const { nonce, cookie } = stateCookie({ from: "dashboard", uid: "user_a", ws: WS });
    await GET(signedCallback({ state: nonce, cookie }));
    expect(m.acquireLease).toHaveBeenCalledWith(SHOP, "user_a", 60);
    expect(m.check).toHaveBeenCalledWith(SHOP, "holder-1", "user_a", null);
    expect(m.check.mock.invocationCallOrder[0]).toBeLessThan(m.fetchWithRetry.mock.invocationCallOrder[0]);
    expect(m.seal).toHaveBeenCalledWith(548380009, expect.objectContaining({ accessToken: "shpat_test", refreshToken: "shprt_test" }));
    expect(m.commit).toHaveBeenCalledWith({
      leaseDomain: SHOP, holder: "holder-1", shopifyShopId: 548380009, domain: SHOP,
      actor: "user_a", selectedWorkspaceId: WS, shopName: "Attacker", transferId: null,
      credential: { sealed: true, shopId: 548380009 },
    });
    expect(m.upsertUserIntegration).toHaveBeenCalledWith("user_a", expect.objectContaining({ shopify_store_url: SHOP }));
    expect(m.releaseLease).toHaveBeenCalledWith(SHOP, "holder-1");
  });

  it("stores the token only encrypted with the binding, never on the legacy account row (task 4)", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    const { nonce, cookie } = stateCookie({ from: "dashboard", uid: "user_a" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    const legacy = JSON.stringify([...m.upsertUserIntegration.mock.calls, ...m.updateUserIntegration.mock.calls]);
    expect(legacy).not.toMatch(/shpat_test|shprt_test/);
    expect(setCookies(res)).toContain("omnitarget_workspace=ws-new; Path=/; HttpOnly");
  });

  it("signs a signed-out merchant into the shop's current owner, not a legacy link", async () => {
    m.shopOwner.mockResolvedValue("user_owner");
    m.getUserIdsLinkedToStore.mockResolvedValue(["user_legacy"]);
    const { nonce, cookie } = stateCookie({ from: "login" });
    await GET(signedCallback({ state: nonce, cookie }));
    expect(m.getUserIdsLinkedToStore).not.toHaveBeenCalled();
    expect(m.createSignInToken).toHaveBeenCalledWith({ userId: "user_owner", expiresInSeconds: 300 });
  });

  it("refuses a store owned by another account before exchanging the code", async () => {
    m.auth.mockResolvedValue({ userId: "user_b" });
    m.check.mockResolvedValue("rejected_other_owner");
    const { nonce, cookie } = stateCookie({ from: "onboarding", uid: "user_b" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.headers.get("location")).toContain("error=shopify_auth_failed");
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("another Omnitarget account");
    expect(m.fetchWithRetry).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
    expect(m.releaseLease).toHaveBeenCalledWith(SHOP, "holder-1");
  });

  it("never exchanges while another installation of the store holds the lease", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      m.auth.mockResolvedValue({ userId: "user_b" });
      m.acquireLease.mockResolvedValue(null);
      const { nonce, cookie } = stateCookie({ from: "onboarding", uid: "user_b" });
      const pending = GET(signedCallback({ state: nonce, cookie }));
      await vi.runAllTimersAsync();
      const res = await pending;
      expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("being connected right now");
      expect(m.acquireLease).toHaveBeenCalledTimes(20);
      expect(m.check).not.toHaveBeenCalled();
      expect(m.fetchWithRetry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores nothing when its lease was taken over before the commit", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    m.commit.mockResolvedValue({ outcome: "rejected_lease_lost" });
    const { nonce, cookie } = stateCookie({ from: "onboarding", uid: "user_a" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.headers.get("location")).toContain("error=shopify_auth_failed");
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer credential when its lease expired after the commit", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    m.leaseHeld.mockResolvedValue(false);
    const { nonce, cookie } = stateCookie({ from: "onboarding", uid: "user_a" });
    await GET(signedCallback({ state: nonce, cookie }));
    expect(m.commit).toHaveBeenCalled();
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });

  it("fails closed when the ownership check errors", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    m.check.mockRejectedValue(new Error("db down"));
    const { nonce, cookie } = stateCookie({ from: "onboarding", uid: "user_a" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.headers.get("location")).toContain("error=shopify_auth_failed");
    expect(m.fetchWithRetry).not.toHaveBeenCalled();
    expect(m.releaseLease).toHaveBeenCalled();
  });

  it("stores nothing when the binding is refused after the exchange", async () => {
    m.auth.mockResolvedValue({ userId: "user_b" });
    m.commit.mockResolvedValue({ outcome: "rejected_other_owner" });
    const { nonce, cookie } = stateCookie({ from: "onboarding", uid: "user_b" });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(res.headers.get("location")).toContain("error=shopify_auth_failed");
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
    expect(m.grantFreeCredit).not.toHaveBeenCalled();
  });

  it("grants the free credit to the newly bound workspace through the ledger and welcomes only on a real grant (task 5)", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    m.grantFreeCredit.mockResolvedValue("granted");
    let state = stateCookie({ from: "dashboard", uid: "user_a" });
    await GET(signedCallback({ state: state.nonce, cookie: state.cookie }));
    expect(m.grantFreeCredit).toHaveBeenCalledWith("ws-new", "user_a");
    expect(m.sendEmail).toHaveBeenCalledTimes(1);

    m.sendEmail.mockClear();
    m.grantFreeCredit.mockResolvedValue("shop_already_granted");
    state = stateCookie({ from: "dashboard", uid: "user_a" });
    await GET(signedCallback({ state: state.nonce, cookie: state.cookie }));
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("connecting a second store leaves the first store's workspace and credential alone (task 4)", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    m.getUserIntegration.mockResolvedValue({ shopify_store_url: "old-store.myshopify.com", free_credit_used: true });
    const { nonce, cookie } = stateCookie({ from: "dashboard", uid: "user_a" });
    await GET(signedCallback({ state: nonce, cookie }));
    expect(m.commit).toHaveBeenCalledTimes(1);
    expect(m.disconnectShopInstallation).not.toHaveBeenCalled();
  });

  it("verifies a requested transfer without exchanging the code", async () => {
    m.auth.mockResolvedValue({ userId: "user_b" });
    m.transferForRequester.mockResolvedValue({ status: "requested", shop_domain: SHOP });
    const { nonce, cookie } = stateCookie({ from: "dashboard", uid: "user_b", tr: TR });
    const res = await GET(signedCallback({ state: nonce, cookie }));
    expect(m.transferForRequester).toHaveBeenCalledWith(TR, "user_b");
    expect(m.verifyTransfer).toHaveBeenCalledWith(TR, "user_b", SHOP);
    expect(res.headers.get("location")).toBe(`${APP}/dashboard?transfer=verified`);
    expect(m.fetchWithRetry).not.toHaveBeenCalled();
    expect(m.acquireLease).not.toHaveBeenCalled();
  });

  it("completes an approved transfer with the new owner's own installation, under the lease", async () => {
    m.auth.mockResolvedValue({ userId: "user_b" });
    m.transferForRequester.mockResolvedValue({ status: "approved", shop_domain: SHOP });
    const { nonce, cookie } = stateCookie({ from: "dashboard", uid: "user_b", tr: TR });
    await GET(signedCallback({ state: nonce, cookie }));
    expect(m.check).toHaveBeenCalledWith(SHOP, "holder-1", "user_b", TR);
    expect(m.commit).toHaveBeenCalledWith(expect.objectContaining({
      leaseDomain: SHOP, holder: "holder-1", transferId: TR, actor: "user_b", shopifyShopId: 548380009,
      credential: { sealed: true, shopId: 548380009 },
    }));
    expect(m.disconnectShopInstallation).toHaveBeenCalledWith(SHOP);
    expect(m.disconnectShopInstallation.mock.invocationCallOrder[0]).toBeLessThan(m.upsertUserIntegration.mock.invocationCallOrder[0]);
    expect(JSON.stringify(m.upsertUserIntegration.mock.calls)).not.toContain("shpat_test");
  });

  it("refuses a transfer that is not the user's, not for this store, or not yet approved", async () => {
    m.auth.mockResolvedValue({ userId: "user_b" });
    for (const transfer of [null, { status: "approved", shop_domain: "other.myshopify.com" }, { status: "verified", shop_domain: SHOP }]) {
      m.transferForRequester.mockResolvedValue(transfer);
      const { nonce, cookie } = stateCookie({ from: "dashboard", uid: "user_b", tr: TR });
      const res = await GET(signedCallback({ state: nonce, cookie }));
      expect(res.headers.get("location")).toContain("error=shopify_auth_failed");
    }
    expect(m.fetchWithRetry).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });
});

describe("Shopify OAuth callback — request authenticity", () => {
  it("rejects an invalid HMAC with 401", async () => {
    const { nonce, cookie } = stateCookie();
    const res = await GET(signedCallback({ state: nonce, cookie, tamper: true }));
    expect(res.status).toBe(401);
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp (replayed redirect)", async () => {
    const { nonce, cookie } = stateCookie();
    const res = await GET(signedCallback({ state: nonce, cookie, timestamp: Math.floor(Date.now() / 1000) - 3600 }));
    expect(res.headers.get("location")).toContain("error=shopify_auth_failed");
    expect(m.fetchWithRetry).not.toHaveBeenCalled();
  });
});
