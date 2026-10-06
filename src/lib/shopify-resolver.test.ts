import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveShopifyDomain } from "./shopify-resolver";

describe("resolveShopifyDomain", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects empty input with an explanatory message", async () => {
    const result = await resolveShopifyDomain("");
    expect(result.isShopify).toBe(false);
    expect(result.error).toBe("Please enter your store website.");
  });

  it("detects a nonexistent .myshopify.com store when Shopify returns 404", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    } as Response);

    const result = await resolveShopifyDomain(
      "this-is-a-very-long-store-name-that-a-merchant-might-have.myshopify.com"
    );

    expect(result.isShopify).toBe(false);
    expect(result.myshopifyDomain).toBeNull();
    expect(result.error).toBe(
      "This Shopify store could not be found. Please check your store name or URL."
    );
  });

  it("accepts an active .myshopify.com store when Shopify returns 200/301/302", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 301,
      ok: false, // 301 is not 2xx but indicates store exists
    } as Response);

    const result = await resolveShopifyDomain("cool-brand.myshopify.com");
    expect(result.isShopify).toBe(true);
    expect(result.myshopifyDomain).toBe("cool-brand.myshopify.com");
  });

  it("resolves a custom domain via meta.json endpoint", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/meta.json")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ myshopify_domain: "k-kasa.myshopify.com" }),
          headers: new Headers(),
        } as unknown as Response);
      }
      return Promise.reject(new Error("unexpected call"));
    });

    const result = await resolveShopifyDomain("k-kasa.com");
    expect(result.isShopify).toBe(true);
    expect(result.myshopifyDomain).toBe("k-kasa.myshopify.com");
  });

  it("resolves a custom domain via root HTML with myshopify link", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/meta.json")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          headers: new Headers(),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () =>
          Promise.resolve('<html><head><script>var Shopify = {shop: "brand.myshopify.com"};</script></head></html>'),
      } as unknown as Response);
    });

    const result = await resolveShopifyDomain("customstore.com");
    expect(result.isShopify).toBe(true);
    expect(result.myshopifyDomain).toBe("brand.myshopify.com");
  });

  it("distinguishes reachable non-Shopify sites from connection errors", async () => {
    // Like omnitarget.co: meta.json returns 404, root returns 200 without Shopify markers
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/meta.json")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          headers: new Headers(),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ server: "Vercel" }),
        text: () => Promise.resolve("<html><body>Welcome to our landing page</body></html>"),
      } as unknown as Response);
    });

    const result = await resolveShopifyDomain("omnitarget.co");
    expect(result.isShopify).toBe(false);
    expect(result.myshopifyDomain).toBeNull();
    expect(result.error).toBe(
      "We could not detect a Shopify store at this domain. Please verify your store URL or enter your .myshopify.com address."
    );
  });

  it("returns network/DNS unreachable error when fetch throws network error", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed: ENOTFOUND"));

    const result = await resolveShopifyDomain("completely-fake-unreachable-domain-123498.com");
    expect(result.isShopify).toBe(false);
    expect(result.myshopifyDomain).toBeNull();
    expect(result.error).toBe(
      "Could not reach this website. Please verify your domain and internet connection."
    );
  });
});
