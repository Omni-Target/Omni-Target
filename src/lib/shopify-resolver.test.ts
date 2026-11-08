import { describe, it, expect, vi, beforeEach } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/net/safe-fetch", () => ({ safeFetch }));

import { resolveShopifyDomain } from "./shopify-resolver";

type Fake = { status: number; headers?: Record<string, string>; body?: string; truncated?: boolean };
const reply = (r: Fake) => ({
  status: r.status,
  headers: r.headers ?? {},
  body: Buffer.from(r.body ?? ""),
  truncated: r.truncated ?? false,
  url: "https://example.test/",
});

describe("resolveShopifyDomain", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it("rejects empty input with an explanatory message", async () => {
    const result = await resolveShopifyDomain("");
    expect(result.isShopify).toBe(false);
    expect(result.error).toBe("Please enter your store website.");
  });

  it("detects a nonexistent .myshopify.com store when Shopify returns 404", async () => {
    safeFetch.mockResolvedValue(reply({ status: 404 }));
    const result = await resolveShopifyDomain(
      "this-is-a-very-long-store-name-that-a-merchant-might-have.myshopify.com",
    );
    expect(result.isShopify).toBe(false);
    expect(result.myshopifyDomain).toBeNull();
    expect(result.error).toBe("This Shopify store could not be found. Please check your store name or URL.");
  });

  it("accepts an active .myshopify.com store when Shopify returns 200/301/302", async () => {
    safeFetch.mockResolvedValue(reply({ status: 301 }));
    const result = await resolveShopifyDomain("cool-brand.myshopify.com");
    expect(result.isShopify).toBe(true);
    expect(result.myshopifyDomain).toBe("cool-brand.myshopify.com");
  });

  it("resolves a custom domain via meta.json endpoint", async () => {
    safeFetch.mockImplementation(async (url: string) => {
      if (url.includes("/meta.json")) return reply({ status: 200, body: JSON.stringify({ myshopify_domain: "k-kasa.myshopify.com" }) });
      throw new Error("unexpected call");
    });
    const result = await resolveShopifyDomain("k-kasa.com");
    expect(result.isShopify).toBe(true);
    expect(result.myshopifyDomain).toBe("k-kasa.myshopify.com");
  });

  it("resolves a custom domain via root HTML with myshopify link", async () => {
    safeFetch.mockImplementation(async (url: string) =>
      url.includes("/meta.json")
        ? reply({ status: 404 })
        : reply({ status: 200, body: '<html><head><script>var Shopify = {shop: "brand.myshopify.com"};</script></head></html>' }),
    );
    const result = await resolveShopifyDomain("customstore.com");
    expect(result.isShopify).toBe(true);
    expect(result.myshopifyDomain).toBe("brand.myshopify.com");
  });

  it("distinguishes reachable non-Shopify sites from connection errors", async () => {
    safeFetch.mockImplementation(async (url: string) =>
      url.includes("/meta.json")
        ? reply({ status: 404 })
        : reply({ status: 200, headers: { server: "Vercel" }, body: "<html><body>Welcome to our landing page</body></html>" }),
    );
    const result = await resolveShopifyDomain("omnitarget.co");
    expect(result.isShopify).toBe(false);
    expect(result.myshopifyDomain).toBeNull();
    expect(result.error).toBe(
      "We could not detect a Shopify store at this domain. Please verify your store URL or enter your .myshopify.com address.",
    );
  });

  it("returns network/DNS unreachable error when fetch throws network error", async () => {
    safeFetch.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "network" }));
    const result = await resolveShopifyDomain("completely-fake-unreachable-domain-123498.com");
    expect(result.isShopify).toBe(false);
    expect(result.myshopifyDomain).toBeNull();
    expect(result.error).toBe("Could not reach this website. Please verify your domain and internet connection.");
  });
});

describe("resolveShopifyDomain — SEC-07 SSRF / open-redirect hardening", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it("never returns a non-myshopify domain supplied by a hostile meta.json", async () => {
    safeFetch.mockImplementation(async (url: string) =>
      url.includes("/meta.json")
        ? reply({ status: 200, body: JSON.stringify({ myshopify_domain: "evil.example" }) })
        : reply({ status: 200, body: "<html>no markers</html>" }),
    );
    const result = await resolveShopifyDomain("attacker-site.com");
    expect(result.myshopifyDomain).toBeNull();
  });

  it("does not treat lookalike hosts containing 'myshopify.com' as Shopify stores", async () => {
    safeFetch.mockResolvedValue(reply({ status: 200, body: "<html></html>" }));
    const result = await resolveShopifyDomain("myshopify.com.evil.internal");
    expect(result.myshopifyDomain).toBeNull();
    // It is handled as an ordinary custom domain, i.e. via the DNS-validated fetcher.
    expect(safeFetch).toHaveBeenCalledWith("https://myshopify.com.evil.internal/meta.json", expect.any(Object));
  });

  it("reports a blocked internal destination exactly like an unreachable site (no reachability oracle)", async () => {
    safeFetch.mockRejectedValue(Object.assign(new Error("blocked"), { code: "blocked_destination" }));
    const result = await resolveShopifyDomain("127.0.0.1.nip.io");
    expect(result).toEqual({
      myshopifyDomain: null,
      isShopify: false,
      error: "Could not reach this website. Please verify your domain and internet connection.",
    });
  });

  it("asks for the .myshopify.com address when Shopify is detected but its domain is not exposed", async () => {
    safeFetch.mockImplementation(async (url: string) =>
      url.includes("/meta.json")
        ? reply({ status: 404, headers: { "x-shopify-shop-id": "123" } })
        : reply({ status: 200, body: "<html>cdn.shopify.com</html>" }),
    );
    const result = await resolveShopifyDomain("brand.com");
    expect(result.isShopify).toBe(true);
    expect(result.myshopifyDomain).toBeNull();
    expect(result.error).toMatch(/myshopify\.com address/);
  });
});
