import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserIntegration: vi.fn(),
  updateUserIntegration: vi.fn(),
  fetchShopifyStoreData: vi.fn(),
  getValidShopifyToken: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getUserIntegration: m.getUserIntegration, updateUserIntegration: m.updateUserIntegration }));
vi.mock("@/lib/connectors/shopify", () => ({ fetchShopifyStoreData: m.fetchShopifyStoreData }));
vi.mock("@/lib/shopify-token", () => ({ getValidShopifyToken: m.getValidShopifyToken }));

import { GET } from "./route";

const snapshot = (label: string) => ({ label, data_quality: { schema_version: 9 }, orders: { orders_last_30_days: 1 }, products: [] });
const call = (force = false) => GET(new Request(`https://app.test/api/store/data${force ? "?force=true" : ""}`));
let n = 0;
const nextUser = () => `user_${n++}`;
const cacheControl = (res: Response) => res.headers.get("cache-control") ?? "";

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.auth.mockResolvedValue({ userId: nextUser() });
  m.getUserIntegration.mockResolvedValue({ store_snapshot: snapshot("old"), store_snapshot_at: new Date().toISOString(), shopify_scopes: null });
  m.getValidShopifyToken.mockResolvedValue({ status: "ok", accessToken: "t", shopUrl: "s.myshopify.com" });
  m.fetchShopifyStoreData.mockResolvedValue(snapshot("fresh"));
  m.updateUserIntegration.mockResolvedValue(undefined);
});

describe("forced store sync responses are never cacheable (fix 8.2)", () => {
  it("marks a successful forced sync private and no-store, at the browser and the CDN", async () => {
    const res = await call(true);
    expect((await res.json()).data.label).toBe("fresh");
    expect(cacheControl(res)).toBe("private, no-store, max-age=0");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    expect(cacheControl(res)).not.toMatch(/max-age=[1-9]|stale-while-revalidate/);
  });

  it.each([
    ["not connected", () => m.getValidShopifyToken.mockResolvedValue({ status: "not_connected" }), 200],
    ["reconnect required", () => m.getValidShopifyToken.mockResolvedValue({ status: "reauth_required", shopUrl: "s" }), 200],
    ["Shopify unavailable, last snapshot shown", () => m.getValidShopifyToken.mockResolvedValue({ status: "temporarily_unavailable", shopUrl: "s" }), 200],
    ["Shopify unavailable, nothing to show", () => {
      m.getValidShopifyToken.mockResolvedValue({ status: "temporarily_unavailable", shopUrl: "s" });
      m.getUserIntegration.mockResolvedValue(null);
    }, 503],
    ["sync failed, fallback snapshot", () => m.fetchShopifyStoreData.mockRejectedValue(new Error("timeout")), 200],
    ["sync failed, nothing to show", () => {
      m.fetchShopifyStoreData.mockRejectedValue(new Error("timeout"));
      m.getUserIntegration.mockResolvedValue(null);
    }, 500],
    ["signed out", () => m.auth.mockResolvedValue({ userId: null }), 401],
  ])("keeps a forced response uncacheable when %s", async (_label, arrange, status) => {
    arrange();
    const res = await call(true);
    expect(res.status).toBe(status);
    expect(cacheControl(res)).toBe("private, no-store, max-age=0");
  });
});

describe("ordinary snapshot responses", () => {
  it("may be stored privately but must be revalidated, and are never cached by the CDN", async () => {
    const res = await call(false);
    expect(cacheControl(res)).toBe("private, no-cache");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("never return data older than an explicit forced refresh", async () => {
    m.auth.mockResolvedValue({ userId: "user_sequence" });
    expect((await (await call(false)).json()).data.label).toBe("old");
    expect((await (await call(true)).json()).data.label).toBe("fresh");
    m.getUserIntegration.mockResolvedValue({ store_snapshot: snapshot("fresh"), store_snapshot_at: new Date().toISOString(), shopify_scopes: null });
    const after = await call(false);
    expect((await after.json()).data.label).toBe("fresh");
    expect(cacheControl(after)).toBe("private, no-cache");
  });
});
