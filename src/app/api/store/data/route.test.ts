import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  loadStoreInsights: vi.fn(),
  dispatchShopInsights: vi.fn(),
  getValidShopifyToken: vi.fn(),
  after: vi.fn(),
}));
vi.mock("next/server", () => ({ after: m.after }));
vi.mock("@clerk/nextjs/server", () => ({ auth: m.auth }));
vi.mock("@/modules/insights/read", () => ({ loadStoreInsights: m.loadStoreInsights }));
vi.mock("@/modules/jobs/trigger", () => ({ dispatchShopInsights: m.dispatchShopInsights, insightsWindow: (kind: string) => `${kind}-window` }));
vi.mock("@/lib/shopify-token", () => ({ getValidShopifyToken: m.getValidShopifyToken }));

import { GET } from "./route";

const snapshot = (label: string) => ({ label, data_quality: { schema_version: 9 }, orders: { orders_last_30_days: 1 }, products: [] });
const stored = (label: string, ageMs = 0, grantedScopes: string[] = []) => ({
  connected: true, shopDomain: "s.myshopify.com", shopKey: 2, data: snapshot(label), computedAt: new Date(Date.now() - ageMs).toISOString(), grantedScopes,
});
const call = (force = false) => GET(new Request(`https://app.test/api/store/data${force ? "?force=true" : ""}`));
const cacheControl = (res: Response) => res.headers.get("cache-control") ?? "";
const dispatched = async () => {
  for (const [fn] of m.after.mock.calls) await (fn as () => Promise<unknown>)();
  return m.dispatchShopInsights.mock.calls.map((c) => c[1]);
};

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.auth.mockResolvedValue({ userId: "user_1" });
  m.loadStoreInsights.mockResolvedValue(stored("current"));
  m.getValidShopifyToken.mockResolvedValue({ status: "ok", accessToken: "t", shopUrl: "s.myshopify.com" });
  m.dispatchShopInsights.mockResolvedValue("run_1");
});

describe("the store snapshot is read, never synced, in the request (task 11)", () => {
  it("answers a fresh snapshot as stored, without asking Shopify or the worker", async () => {
    const res = await call(false);
    expect(await res.json()).toMatchObject({ connected: true, data: { label: "current" }, refreshing: false });
    expect(m.getValidShopifyToken).not.toHaveBeenCalled();
    expect(await dispatched()).toEqual([]);
  });

  it("asks the worker for a new snapshot when the stored one is stale, missing or a refresh is forced", async () => {
    m.loadStoreInsights.mockResolvedValueOnce(stored("old", 2 * 3_600_000));
    expect(await (await call(false)).json()).toMatchObject({ data: { label: "old" }, refreshing: true });
    m.loadStoreInsights.mockResolvedValueOnce({ ...stored("none"), data: null, computedAt: null });
    expect(await (await call(false)).json()).toMatchObject({ connected: true, data: null, refreshing: true });
    expect(await (await call(true)).json()).toMatchObject({ data: { label: "current" }, refreshing: true });
    expect(await dispatched()).toEqual(["stale-window", "stale-window", "user-window"]);
  });

  it("asks the merchant to reconnect when the session is dead, and reports a store not connected", async () => {
    m.getValidShopifyToken.mockResolvedValueOnce({ status: "reauth_required", shopUrl: "s" });
    expect(await (await call(true)).json()).toMatchObject({ connected: false, reauthRequired: true });
    m.loadStoreInsights.mockResolvedValueOnce({ connected: false, shopDomain: null, shopKey: null, data: null, computedAt: null, grantedScopes: [] });
    expect(await (await call(false)).json()).toMatchObject({ connected: false });
    expect(await dispatched()).toEqual([]);
  });

  it("flags missing scopes only once the shop's granted scopes are known", async () => {
    expect(await (await call(false)).json()).toMatchObject({ needsShopifyReauthorization: false, missingShopifyScopes: [] });
    m.loadStoreInsights.mockResolvedValueOnce(stored("current", 0, ["read_products"]));
    const body = await (await call(false)).json();
    expect(body.needsShopifyReauthorization).toBe(true);
    expect(body.missingShopifyScopes).toContain("read_all_orders");
  });
});

describe("cache headers (fix 8.2)", () => {
  it("marks a forced refresh private and no-store, at the browser and the CDN, whatever happens", async () => {
    const res = await call(true);
    expect(cacheControl(res)).toBe("private, no-store, max-age=0");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    m.getValidShopifyToken.mockResolvedValueOnce({ status: "reauth_required", shopUrl: "s" });
    expect(cacheControl(await call(true))).toBe("private, no-store, max-age=0");
    m.auth.mockResolvedValueOnce({ userId: null });
    const signedOut = await call(true);
    expect(signedOut.status).toBe(401);
    expect(cacheControl(signedOut)).toBe("private, no-store, max-age=0");
  });

  it("lets an ordinary read be stored privately but revalidated, and never cached by the CDN", async () => {
    const res = await call(false);
    expect(cacheControl(res)).toBe("private, no-cache");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });
});
