import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware:
    (handler: (authFn: typeof auth, req: NextRequest) => unknown) =>
    (req: NextRequest) =>
      handler(auth, req),
  createRouteMatcher: (patterns: string[]) => {
    const compiled = patterns.map((p) => new RegExp(`^${p}$`));
    return (req: NextRequest) => compiled.some((re) => re.test(req.nextUrl.pathname));
  },
  clerkClient: vi.fn(),
}));

import proxy from "./proxy";

const SECRET = "test-shopify-secret";
const now = () => String(Math.floor(Date.now() / 1000));
function signedQuery(params: Record<string, string>) {
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const hmac = createHmac("sha256", SECRET).update(message).digest("hex");
  return new URLSearchParams({ ...params, hmac }).toString();
}
const run = async (path: string) =>
  (await proxy(new NextRequest(`https://app.test${path}`), {} as never)) as Response | undefined;
const redirectedToOAuth = (res: Response | undefined) =>
  res?.headers.get("location")?.includes("/api/auth/shopify/connect") ?? false;

beforeEach(() => {
  vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
  auth.mockReset().mockResolvedValue({ userId: null, sessionClaims: null });
});

describe("Shopify app entry (SEC-10)", () => {
  it("starts OAuth for Shopify's signed install at the App URL root, keeping its parameters", async () => {
    const query = signedQuery({ shop: "store.myshopify.com", timestamp: now(), host: "abc" });
    const res = await run(`/?${query}`);
    expect(redirectedToOAuth(res)).toBe(true);
    const location = new URL(res!.headers.get("location")!);
    expect(location.searchParams.get("shop")).toBe("store.myshopify.com");
    expect(location.searchParams.get("from")).toBe("app_store");
    expect(location.searchParams.get("hmac")).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["no signature", () => "/?shop=victim.myshopify.com"],
    ["a forged signature", () => `/?shop=victim.myshopify.com&timestamp=${now()}&hmac=${"a".repeat(64)}`],
    ["a tampered shop", () => `/?${signedQuery({ shop: "a.myshopify.com", timestamp: now() }).replace("a.myshopify", "b.myshopify")}`],
    ["an old signed link", () => `/?${signedQuery({ shop: "a.myshopify.com", timestamp: String(Math.floor(Date.now() / 1000) - 3600) })}`],
  ])("does not start OAuth for %s", async (_label, path) => {
    expect(redirectedToOAuth(await run(path()))).toBe(false);
  });

  it("does not treat a signed query on another path as an install", async () => {
    auth.mockResolvedValue({ userId: "user_1", sessionClaims: { onboardingStep: "complete", metadata: { onboardingStep: "complete" } } });
    const query = signedQuery({ shop: "store.myshopify.com", timestamp: now() });
    expect(redirectedToOAuth(await run(`/dashboard?${query}`))).toBe(false);
  });
});

describe("Shopify billing return", () => {
  const billingReturn = "/api/shopify/billing/callback?shop=store.myshopify.com&uid=user_1&charge_id=123";

  it("reaches the billing callback instead of being redirected into OAuth", async () => {
    const res = await run(billingReturn);
    expect(redirectedToOAuth(res)).toBe(false);
    expect(res?.headers.get("location") ?? null).toBeNull(); // no redirect: the request continues
  });

  it("does not bounce a merchant whose session lapsed during checkout to login", async () => {
    const res = await run(billingReturn);
    expect(res?.headers.get("location") ?? "").not.toContain("/login");
    expect(auth).not.toHaveBeenCalled();
  });
});
