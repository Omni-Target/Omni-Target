import { afterEach, describe, expect, it, vi } from "vitest";
import { extractStoreLogoFromHtml, fetchShopifyStoreLogo } from "./shopify-store-logo";
import { normalizeStoreLogoUrl } from "./store-logo-url";

afterEach(() => vi.unstubAllGlobals());

describe("Shopify store logo discovery", () => {
  it("uses the original Shopify image behind a 32px storefront icon", () => {
    const html = `<link rel="icon" type="image/png" href="//k-kasa.com/cdn/shop/files/kasa-favicon.png?crop=center&amp;height=32&amp;v=123&amp;width=32">`;
    expect(extractStoreLogoFromHtml(html, "https://k-kasa.com/")).toBe(
      "https://k-kasa.com/cdn/shop/files/kasa-favicon.png?v=123",
    );
  });

  it("prefers a configured organization logo over a storefront icon or hero image", () => {
    const html = `
      <meta property="og:image" content="https://store.com/hero.jpg">
      <script type="application/ld+json">{"@graph":[{"@type":"Organization","logo":{"url":"https://cdn.shopify.com/s/files/logo.png?width=100"}}]}</script>
      <link rel="icon" href="https://store.com/cdn/shop/files/favicon.png?width=32">
    `;
    expect(extractStoreLogoFromHtml(html, "https://store.com/")).toBe(
      "https://cdn.shopify.com/s/files/logo.png",
    );
  });

  it("uses a theme header logo when structured data is absent", () => {
    const html = `<img class="header__heading-logo" data-src="/cdn/shop/files/brand.svg?v=2" src="/placeholder.gif">`;
    expect(extractStoreLogoFromHtml(html, "https://store.com/")).toBe(
      "https://store.com/cdn/shop/files/brand.svg?v=2",
    );
  });

  it("rejects proxy favicons and unrelated social images", () => {
    expect(normalizeStoreLogoUrl("https://www.google.com/s2/favicons?domain=store.com")).toBeNull();
    expect(extractStoreLogoFromHtml('<meta property="og:image" content="https://store.com/hero.jpg">', "https://store.com/")).toBeNull();
  });

  it("reads only verified store domains", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response('<link rel="icon" href="/cdn/shop/files/brand.png?width=32">', {
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchShopifyStoreLogo("store.myshopify.com", "store.com")).toBe(
      "https://store.com/cdn/shop/files/brand.png",
    );
    expect(fetchMock).toHaveBeenCalledWith("https://store.com/", expect.any(Object));
    fetchMock.mockClear();
    expect(await fetchShopifyStoreLogo("store.myshopify.com", "127.0.0.1")).toBe(
      "https://store.myshopify.com/cdn/shop/files/brand.png",
    );
    expect(fetchMock).toHaveBeenCalledWith("https://store.myshopify.com/", expect.any(Object));
  });
});
