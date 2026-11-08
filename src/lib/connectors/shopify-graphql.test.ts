import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectDeniedFields, shopifyGraphql } from "./shopify-graphql";
import { fetchShopifyPrespendIntelligence } from "./shopify-intelligence";

const respond = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const denial = (path: Array<string | number>) => ({
  message: "Access denied for email field.",
  path,
  extensions: { code: "ACCESS_DENIED" },
});
const throttled = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } },
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("shopifyGraphql partial failures (ING-06)", () => {
  it("keeps the data when a protected field is denied and records it once", async () => {
    fetchMock.mockResolvedValue(
      respond({
        data: { orders: { nodes: [{ id: "1", email: null }, { id: "2", email: null }] } },
        errors: [denial(["orders", "nodes", 0, "email"]), denial(["orders", "nodes", 1, "email"])],
      }),
    );
    const { value, deniedFields } = await collectDeniedFields(() =>
      shopifyGraphql<{ orders: { nodes: unknown[] } }>("s.myshopify.com", "t", "query"),
    );
    expect(value.orders.nodes).toHaveLength(2);
    expect(deniedFields).toEqual(["orders.nodes.email"]);
  });

  it("still fails when the whole query is denied, or another error accompanies a denial", async () => {
    fetchMock.mockResolvedValueOnce(respond({ data: null, errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] }));
    await expect(shopifyGraphql("s.myshopify.com", "t", "query")).rejects.toThrow("Access denied");

    fetchMock.mockResolvedValueOnce(respond({ data: { a: 1 }, errors: [denial(["a"]), { message: "Boom" }] }));
    await expect(shopifyGraphql("s.myshopify.com", "t", "query")).rejects.toThrow("Boom");
  });

  it("backs off and retries when throttled", async () => {
    fetchMock.mockResolvedValueOnce(respond(throttled)).mockResolvedValueOnce(respond({ data: { ok: true } }));
    await expect(shopifyGraphql("s.myshopify.com", "t", "query")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after bounded throttle retries", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => respond(throttled));
    const result = expect(shopifyGraphql("s.myshopify.com", "t", "query")).rejects.toThrow("throttled");
    await vi.runAllTimersAsync();
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("keeps concurrent scopes apart", async () => {
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      const field = String(init.body).includes("A") ? "a" : "b";
      return respond({ data: { [field]: null }, errors: [denial([field])] });
    });
    const [first, second] = await Promise.all([
      collectDeniedFields(() => shopifyGraphql("s.myshopify.com", "t", "A")),
      collectDeniedFields(() => shopifyGraphql("s.myshopify.com", "t", "B")),
    ]);
    expect(first.deniedFields).toEqual(["a"]);
    expect(second.deniedFields).toEqual(["b"]);
  });
});

describe("a denied field does not fail the capability (ING-06)", () => {
  it("reports the capability as partial, keeps its data and warns once", async () => {
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      const body = String(init.body);
      if (body.includes("accessScopes")) {
        return respond({ data: { currentAppInstallation: { accessScopes: [{ handle: "read_markets" }] } } });
      }
      if (body.includes("PrespendMarkets")) {
        return respond({
          data: { markets: { nodes: [{ id: "m1", name: "UK", status: "ACTIVE", regions: { nodes: [{ name: "United Kingdom", code: "GB" }] } }] } },
          errors: [denial(["markets", "nodes", 0, "someProtectedField"])],
        });
      }
      return respond({ data: null, errors: [{ message: "not under test" }] });
    });

    const result = await fetchShopifyPrespendIntelligence("s.myshopify.com", "t");
    expect(result.prespend.capabilities.markets.status).toBe("partial");
    expect(result.prespend.capabilities.markets.detail).toContain("markets.nodes.someProtectedField");
    expect(result.prespend.markets).toHaveLength(1);
    expect(result.warnings.filter((w) => w.includes("withheld"))).toHaveLength(1);
  });
});
