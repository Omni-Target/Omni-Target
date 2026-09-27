/** Keep authentic store logo image assets, strictly rejecting browser icons and favicons. */
export function normalizeStoreLogoUrl(value?: string | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname === "google.com" || url.hostname.endsWith(".google.com")) return null;
    if (url.pathname.toLowerCase().endsWith(".ico")) return null;

    // Strictly reject browser favicons, apple touch icons, android chrome tiles, and shortcut icons
    if (
      /(?:^|[\/._-])(?:favicon|apple-touch-icon|shortcut-icon|mask-icon|android-chrome)(?:[\/._-]|$)/i.test(
        url.pathname,
      ) ||
      /favicon/i.test(url.search)
    ) {
      return null;
    }

    const isShopifyAsset =
      (url.hostname === "cdn.shopify.com" || url.pathname.startsWith("/cdn/shop/")) &&
      /\.(?:png|jpe?g|webp|avif|svg)$/i.test(url.pathname);

    // Shopify themes often request downscaled versions (e.g. ?width=100) from a larger source.
    if (isShopifyAsset) {
      for (const key of ["width", "height", "crop"]) url.searchParams.delete(key);
    }

    return url.toString();
  } catch {
    return null;
  }
}
