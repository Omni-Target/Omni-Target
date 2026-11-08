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
  detectColumns: vi.fn(),
  handleFreeCreditOnInstall: vi.fn(),
  fetchWithRetry: vi.fn(),
  sendEmail: vi.fn(),
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
}));
vi.mock("@/lib/billing-db", () => ({
  detectColumns: m.detectColumns,
  handleFreeCreditOnInstall: m.handleFreeCreditOnInstall,
}));
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

function stateCookie(input: { from?: "signup" | "login" | "onboarding" | "app_store"; uid?: string | null } = {}) {
  const { nonce, cookieValue } = createOAuthState({
    shop: SHOP,
    from: input.from ?? "signup",
    plan: "",
    initiatorUserId: input.uid ?? null,
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
  m.detectColumns.mockResolvedValue({
    hasShopDomain: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    hasTokenExpiresAt: true,
    hasFreeCreditUsed: true,
    hasCredits: true,
  });
  m.getUserIntegration.mockResolvedValue({ free_credit_used: true });
  m.getUser.mockResolvedValue({ publicMetadata: { onboardingStep: "complete" } });
  m.createSignInToken.mockResolvedValue({ token: "ticket-123" });
  m.getUserList.mockResolvedValue({ data: [{ id: "user_victim" }] });
  m.fetchWithRetry.mockResolvedValue(
    Response.json({ access_token: "shpat_test", refresh_token: "shprt_test", expires_in: 3600, scope: "read_products" }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("shop.json")) {
        // The shop's contact email deliberately matches an existing account.
        return Response.json({ shop: { email: "victim@example.com", myshopify_domain: SHOP, name: "Attacker", domain: null } });
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
