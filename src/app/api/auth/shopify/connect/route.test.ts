import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingInstall, readOAuthState } from "@/lib/shopify-oauth";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveShopifyDomain: vi.fn(),
  getUserIntegration: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: m.auth }));
vi.mock("@/lib/shopify-resolver", () => ({ resolveShopifyDomain: m.resolveShopifyDomain }));
vi.mock("@/lib/db", () => ({ getUserIntegration: m.getUserIntegration }));

import { GET } from "./route";

const APP = "https://app.test";

function setCookies(response: Response): string[] {
  const h = response.headers as Headers & { getSetCookie?: () => string[] };
  return h.getSetCookie ? h.getSetCookie() : [h.get("set-cookie") || ""];
}

function stateFromResponse(res: Response) {
  const raw = setCookies(res).find((c) => c.startsWith("shopify_oauth_state="));
  const value = raw ? decodeURIComponent(raw.split(";")[0].slice("shopify_oauth_state=".length)) : null;
  return readOAuthState(value);
}

beforeEach(() => {
  process.env.SHOPIFY_CLIENT_SECRET = "test-shopify-client-secret";
  process.env.SHOPIFY_CLIENT_ID = "client-id";
  process.env.NEXT_PUBLIC_APP_URL = APP;
  for (const fn of Object.values(m)) fn.mockReset();
  m.auth.mockResolvedValue({ userId: null });
});

describe("Shopify OAuth connect (SEC-01)", () => {
  it("sends only an opaque nonce to Shopify and binds the flow context to a signed cookie", async () => {
    const res = await GET(new Request(`${APP}/api/auth/shopify/connect?shop=store.myshopify.com&from=signup`));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://store.myshopify.com");
    expect(location.pathname).toBe("/admin/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe(`${APP}/api/auth/shopify/callback`);

    const state = location.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(state).not.toContain("___");

    const payload = stateFromResponse(res);
    expect(payload).toMatchObject({ n: state, shop: "store.myshopify.com", from: "signup", uid: null });
  });

  it("records the signed-in initiator and ignores injected `from` values", async () => {
    m.auth.mockResolvedValue({ userId: "user_a" });
    const res = await GET(
      new Request(`${APP}/api/auth/shopify/connect?shop=store.myshopify.com&from=${encodeURIComponent("signup___user_victim")}`),
    );
    expect(stateFromResponse(res)).toMatchObject({ uid: "user_a", from: "onboarding" });
  });

  it("never builds an authorize URL for a custom domain that resolves to a non-Shopify host", async () => {
    m.resolveShopifyDomain.mockResolvedValue({ isShopify: true, myshopifyDomain: "evil.example" });
    const res = await GET(new Request(`${APP}/api/auth/shopify/connect?shop=brand.com&from=signup`));
    expect(res.headers.get("location")).toContain(`${APP}/signup?error=store_not_found`);
    expect(stateFromResponse(res)).toBeNull();
  });

  it("requires a session to resume a pending install", async () => {
    const pending = createPendingInstall({ shop: "store.myshopify.com", from: "app_store", plan: "" });
    const res = await GET(
      new Request(`${APP}/api/auth/shopify/connect?resume=1`, {
        headers: { cookie: `shopify_pending_install=${encodeURIComponent(pending)}` },
      }),
    );
    expect(res.headers.get("location")).toBe(`${APP}/login`);
    expect(stateFromResponse(res)).toBeNull();
  });

  it("resumes a pending install for the signed-in user and clears the pending cookie", async () => {
    m.auth.mockResolvedValue({ userId: "user_new" });
    const pending = createPendingInstall({ shop: "store.myshopify.com", from: "app_store", plan: "growth" });
    const res = await GET(
      new Request(`${APP}/api/auth/shopify/connect?resume=1`, {
        headers: { cookie: `shopify_pending_install=${encodeURIComponent(pending)}` },
      }),
    );
    expect(new URL(res.headers.get("location")!).origin).toBe("https://store.myshopify.com");
    expect(stateFromResponse(res)).toMatchObject({ shop: "store.myshopify.com", uid: "user_new", plan: "growth" });
    expect(setCookies(res).some((c) => c.startsWith("shopify_pending_install=;") && c.includes("Max-Age=0"))).toBe(true);
  });
});
