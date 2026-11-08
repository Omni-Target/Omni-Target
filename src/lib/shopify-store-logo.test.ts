import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/net/safe-fetch", () => ({ safeFetch }));

import { extractStoreLogoFromHtml, fetchShopifyStoreLogo } from "./shopify-store-logo";
import { normalizeStoreLogoUrl } from "./store-logo-url";

const reply = (url: string, contentType: string, body: string, status = 200) => ({
  status,
  headers: { "content-type": contentType },
  body: Buffer.from(body),
  truncated: false,
  url,
});

beforeEach(() => {
  // Block body on purpose: a function returned from beforeEach is run as teardown.
  safeFetch.mockReset();
});

describe("Shopify store logo discovery", () => {
  it("strictly rejects browser favicons and storefront icons", () => {
    const html = `<link rel="icon" type="image/png" href="//k-kasa.com/cdn/shop/files/kasa-favicon.png?crop=center&amp;height=32&amp;v=123&amp;width=32">`;
    expect(extractStoreLogoFromHtml(html, "https://k-kasa.com/")).toBeNull();
  });

  it("prefers official Shopify Brand square logo over theme HTML scraping", async () => {
    const brandResponse = {
      data: {
        shop: {
          brand: {
            squareLogo: {
              image: {
                url: "https://cdn.shopify.com/s/files/1/0774/0882/9677/files/brand-square-logo.jpg?v=1",
              },
            },
            logo: {
              image: {
                url: "https://cdn.shopify.com/s/files/1/0774/0882/9677/files/brand-horizontal-logo.jpg?v=1",
              },
            },
          },
        },
      },
    };

    safeFetch.mockImplementation(async (url: string) =>
      url.includes("/api/2026-07/graphql.json")
        ? reply(url, "application/json", JSON.stringify(brandResponse))
        : reply(url, "text/html", "<img class='header__heading-logo' src='/cdn/shop/files/html-logo.png'>"),
    );

    const logo = await fetchShopifyStoreLogo("store.myshopify.com", "store.com");
    expect(logo).toBe("https://cdn.shopify.com/s/files/1/0774/0882/9677/files/brand-square-logo.jpg?v=1");
  });

  it("prefers a configured organization logo over a storefront icon or hero image", () => {
    const html = `
      <meta property="og:image" content="https://store.com/hero.jpg">
      <script type="application/ld+json">{"@graph":[{"@type":"Organization","logo":{"url":"https://cdn.shopify.com/s/files/logo.png?width=100"}}]}</script>
      <link rel="icon" href="https://store.com/cdn/shop/files/favicon.png?width=32">
    `;
    expect(extractStoreLogoFromHtml(html, "https://store.com/")).toBe("https://cdn.shopify.com/s/files/logo.png");
  });

  it("uses a theme header logo when structured data is absent", () => {
    const html = `<img class="header__heading-logo" data-src="/cdn/shop/files/brand.svg?v=2" src="/placeholder.gif">`;
    expect(extractStoreLogoFromHtml(html, "https://store.com/")).toBe("https://store.com/cdn/shop/files/brand.svg?v=2");
  });

  it("rejects proxy favicons, favicon paths, and unrelated social images", () => {
    expect(normalizeStoreLogoUrl("https://www.google.com/s2/favicons?domain=store.com")).toBeNull();
    expect(normalizeStoreLogoUrl("https://store.com/cdn/shop/files/kasa-favicon.png?v=123")).toBeNull();
    expect(normalizeStoreLogoUrl("https://store.com/favicon.ico")).toBeNull();
    expect(extractStoreLogoFromHtml('<meta property="og:image" content="https://store.com/hero.jpg">', "https://store.com/")).toBeNull();
    expect(extractStoreLogoFromHtml('<img class="header__flag" src="/flag.png">', "https://store.com/")).toBeNull();
  });

  it("reads only verified store domains when falling back to theme HTML", async () => {
    safeFetch.mockImplementation(async (url: string) =>
      url.includes("graphql.json")
        ? reply(url, "application/json", JSON.stringify({ data: { shop: { brand: null } } }))
        : reply(url, "text/html", '<img class="header__heading-logo" src="/cdn/shop/files/brand.png">'),
    );

    expect(await fetchShopifyStoreLogo("store.myshopify.com", "store.com")).toBe("https://store.com/cdn/shop/files/brand.png");
    expect(safeFetch).toHaveBeenCalledWith("https://store.com/api/2026-07/graphql.json", expect.any(Object));
    safeFetch.mockClear();
    expect(await fetchShopifyStoreLogo("store.myshopify.com", "127.0.0.1")).toBe(
      "https://store.myshopify.com/cdn/shop/files/brand.png",
    );
    expect(safeFetch).toHaveBeenCalledWith("https://store.myshopify.com/api/2026-07/graphql.json", expect.any(Object));
    expect(safeFetch).not.toHaveBeenCalledWith(expect.stringContaining("127.0.0.1"), expect.anything());
  });

  it("SEC-07: skips a custom domain the safe fetcher refuses as a non-public destination", async () => {
    safeFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://internal-alias.com/")) {
        throw Object.assign(new Error("resolves to a non-public address"), { code: "blocked_destination" });
      }
      return url.includes("graphql.json")
        ? reply(url, "application/json", JSON.stringify({ data: { shop: { brand: null } } }))
        : reply(url, "text/html", '<img class="header__heading-logo" src="/cdn/shop/files/brand.png">');
    });
    expect(await fetchShopifyStoreLogo("store.myshopify.com", "internal-alias.com")).toBe(
      "https://store.myshopify.com/cdn/shop/files/brand.png",
    );
  });
});
