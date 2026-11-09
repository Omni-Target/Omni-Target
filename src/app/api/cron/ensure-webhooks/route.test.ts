import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ range: vi.fn(), getValidShopifyToken: vi.fn() }));

vi.mock("@/lib/db", () => {
  const chain = { select: () => chain, or: () => chain, order: () => chain, range: h.range };
  return { supabaseAdmin: { from: () => chain } };
});
vi.mock("@/lib/shopify-token", () => ({ getValidShopifyToken: h.getValidShopifyToken }));

import { GET } from "./route";

const SECRET = "cron-secret";
const SHOP = "merchant-store.myshopify.com";
const ADDRESS = "https://app.test/api/shopify/webhook";
const fetchMock = vi.fn();

const call = (query = "", auth = `Bearer ${SECRET}`) =>
  GET(new Request(`https://app.test/api/cron/ensure-webhooks${query}`, { headers: { authorization: auth } }));

const row = (id: string, shop = SHOP) => ({ clerk_user_id: id, shop_domain: shop, shopify_store_url: null });
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

function shopifyHas(hooks: { topic: string; address: string }[], postStatus = 201) {
  const current = [...hooks];
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response(JSON.stringify({ webhooks: current }), { status: 200 });
    if (postStatus < 300) current.push(JSON.parse(init.body as string).webhook);
    return new Response("{}", { status: postStatus });
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  h.range.mockReset().mockResolvedValue({ data: [row("user_1")], error: null });
  h.getValidShopifyToken.mockReset().mockResolvedValue({ status: "ok", accessToken: "shpat_secret", shopUrl: SHOP });
  shopifyHas([]);
});

describe("ensure-webhooks rollout", () => {
  it("rejects a missing or wrong secret and does no work", async () => {
    expect((await call("", "Bearer wrong")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call()).status).toBe(401);
    expect(h.range).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing topics without creating anything by default", async () => {
    shopifyHas([{ topic: "orders/paid", address: ADDRESS }, { topic: "shop/update", address: ADDRESS }]);
    const body = await (await call()).json();
    expect(body.dryRun).toBe(true);
    expect(body.results[0]).toMatchObject({ status: "missing", missing: ["app/uninstalled"], created: [] });
    expect(posts()).toHaveLength(0);
  });

  it("creates only the missing topics when applying", async () => {
    shopifyHas([{ topic: "orders/paid", address: ADDRESS }, { topic: "shop/update", address: ADDRESS }]);
    const body = await (await call("?apply=true")).json();
    expect(body.results[0]).toMatchObject({ status: "repaired", created: ["app/uninstalled"] });
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body).webhook).toEqual({ topic: "app/uninstalled", address: ADDRESS, format: "json" });
  });

  it("leaves a complete shop alone", async () => {
    shopifyHas([
      { topic: "orders/paid", address: ADDRESS }, { topic: "shop/update", address: ADDRESS },
      { topic: "app/uninstalled", address: ADDRESS },
    ]);
    const body = await (await call("?apply=true")).json();
    expect(body.results[0].status).toBe("complete");
    expect(posts()).toHaveLength(0);
  });

  it("does not count a subscription at another address as present", async () => {
    shopifyHas([
      { topic: "orders/paid", address: "https://old.test/hook" },
      { topic: "app/uninstalled", address: ADDRESS },
      { topic: "shop/update", address: ADDRESS },
    ]);
    const body = await (await call()).json();
    expect(body.results[0].missing).toEqual(["orders/paid"]);
  });

  it("does not claim success when Shopify rejects a subscription with 422", async () => {
    shopifyHas([{ topic: "orders/paid", address: ADDRESS }, { topic: "shop/update", address: ADDRESS }], 422);
    const body = await (await call("?apply=true")).json();
    expect(body.results[0]).toMatchObject({ status: "partial", created: [], reason: "create_422" });
  });

  it("accepts a 422 when the subscription is listed afterwards", async () => {
    let lists = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response("{}", { status: 422 });
      lists += 1;
      const hooks = [{ topic: "orders/paid", address: ADDRESS }, { topic: "shop/update", address: ADDRESS }];
      if (lists > 1) hooks.push({ topic: "app/uninstalled", address: ADDRESS });
      return new Response(JSON.stringify({ webhooks: hooks }), { status: 200 });
    });
    const body = await (await call("?apply=true")).json();
    expect(body.results[0]).toMatchObject({ status: "repaired", created: ["app/uninstalled"] });
  });

  it("reports a partial repair when Shopify refuses a topic", async () => {
    shopifyHas([], 500);
    const body = await (await call("?apply=true")).json();
    expect(body.results[0]).toMatchObject({ status: "partial", created: [], reason: "create_500" });
  });

  it("reports a failure when the follow-up listing fails", async () => {
    let lists = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response("{}", { status: 201 });
      lists += 1;
      return lists === 1
        ? new Response(JSON.stringify({ webhooks: [] }), { status: 200 })
        : new Response("{}", { status: 503 });
    });
    const body = await (await call("?apply=true")).json();
    expect(body.results[0]).toMatchObject({ status: "failed", created: [], reason: "list_503" });
  });

  it("skips a shop with no usable token and calls Shopify zero times", async () => {
    h.getValidShopifyToken.mockResolvedValue({ status: "reauth_required", shopUrl: SHOP });
    const body = await (await call("?apply=true")).json();
    expect(body.results[0]).toMatchObject({ status: "skipped", reason: "reauth_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks a shared shop once, falling back to another member's token", async () => {
    h.range.mockResolvedValue({ data: [row("user_1"), row("user_2")], error: null });
    h.getValidShopifyToken
      .mockResolvedValueOnce({ status: "temporarily_unavailable", shopUrl: SHOP })
      .mockResolvedValueOnce({ status: "ok", accessToken: "shpat_secret", shopUrl: SHOP });
    const body = await (await call()).json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe("missing");
    expect(h.getValidShopifyToken).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-production deployment without the refresh guard", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await call();
    expect(response.status).toBe(409);
    expect(h.getValidShopifyToken).not.toHaveBeenCalled();
  });

  it("runs on a non-production deployment when the guard is on", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SHOPIFY_TOKEN_REFRESH_DISABLED", "true");
    expect((await call()).status).toBe(200);
  });

  it("never returns a token or the full shop domain", async () => {
    const text = await (await call()).text();
    expect(text).not.toContain("shpat_secret");
    expect(text).not.toContain(SHOP);
  });

  it("isolates a failing shop from the rest of the page", async () => {
    h.range.mockResolvedValue({ data: [row("user_1"), row("user_2", "other-store.myshopify.com")], error: null });
    h.getValidShopifyToken.mockRejectedValueOnce(new Error("database down shpat_leak"));
    const response = await call();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("shpat_leak");
    expect(JSON.parse(text).summary).toEqual({ failed: 1, missing: 1 });
  });

  it("returns a cursor only when the page is full", async () => {
    expect((await (await call()).json()).nextCursor).toBeNull();
    h.range.mockResolvedValue({
      data: Array.from({ length: 25 }, (_, i) => row(`user_${i}`)),
      error: null,
    });
    expect((await (await call("?cursor=25")).json()).nextCursor).toBe(50);
  });
});
