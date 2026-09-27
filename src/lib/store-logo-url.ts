/** Keep real Shopify image assets, including full-size files named "favicon". */
export function normalizeStoreLogoUrl(value?: string | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname === "google.com" || url.hostname.endsWith(".google.com")) return null;
    if (url.pathname.toLowerCase().endsWith(".ico")) return null;

    const isShopifyAsset =
      (url.hostname === "cdn.shopify.com" || url.pathname.startsWith("/cdn/shop/")) &&
      /\.(?:png|jpe?g|webp|avif|svg)$/i.test(url.pathname);

    if (/favicon/i.test(url.pathname) && !isShopifyAsset) return null;

    if (isShopifyAsset) {
      // Shopify themes often request a 32px favicon from a much larger source.
      for (const key of ["width", "height", "crop"]) url.searchParams.delete(key);
    }

    return url.toString();
  } catch {
    return null;
  }
}
