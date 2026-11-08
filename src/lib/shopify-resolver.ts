import { safeFetch } from "@/lib/net/safe-fetch";

/**
 * Resolve a merchant-entered store domain to its *.myshopify.com domain.
 *
 * SEC-07: every request goes through safeFetch (https only, DNS-validated
 * public destinations, re-validated redirects, size caps), and only a genuine
 * `*.myshopify.com` domain is ever returned as `myshopifyDomain` — a custom
 * domain or a value read from the storefront is never echoed back as one.
 */
const MYSHOPIFY_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const NOT_FOUND = "This Shopify store could not be found. Please check your store name or URL.";
const UNREACHABLE = "Could not reach this website. Please verify your domain and internet connection.";
const NOT_DETECTED =
  "We could not detect a Shopify store at this domain. Please verify your store URL or enter your .myshopify.com address.";
const NEEDS_MYSHOPIFY =
  "This looks like a Shopify store, but we could not determine its .myshopify.com address. Please enter it directly (e.g. yourstore.myshopify.com).";

export interface ShopifyResolution {
  myshopifyDomain: string | null;
  isShopify: boolean;
  error?: string;
}

function myshopifyCandidate(value: unknown): string | null {
  const candidate = String(value ?? "").trim().toLowerCase();
  return MYSHOPIFY_RE.test(candidate) ? candidate : null;
}

export async function resolveShopifyDomain(input: string): Promise<ShopifyResolution> {
  // Clean the input: trim, remove protocol, www, paths, queries, and ports
  const domain = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0]
    .toLowerCase();

  if (!domain) {
    return { myshopifyDomain: null, isShopify: false, error: "Please enter your store website." };
  }

  // 1. Direct .myshopify.com domain: verify the store exists before OAuth.
  //    Nonexistent subdomains return HTTP 404 from Shopify's edge.
  if (domain.endsWith(".myshopify.com") || domain === "myshopify.com") {
    if (!MYSHOPIFY_RE.test(domain)) {
      return { myshopifyDomain: null, isShopify: false, error: NOT_FOUND };
    }
    try {
      const res = await safeFetch(`https://${domain}`, { method: "HEAD", maxRedirects: 0, timeoutMs: 5000, maxBytes: 1024 });
      if (res.status === 404) {
        return { myshopifyDomain: null, isShopify: false, error: NOT_FOUND };
      }
      // Valid store subdomains return 200, 30x, 401 or 403.
      return { myshopifyDomain: domain, isShopify: true };
    } catch {
      return { myshopifyDomain: null, isShopify: false, error: UNREACHABLE };
    }
  }

  // 2. Custom domain: Shopify storefronts expose /meta.json with myshopify_domain.
  let metaNetworkFailed = false;
  let detectedShopify = false;
  try {
    const metaRes = await safeFetch(`https://${domain}/meta.json`, {
      headers: { Accept: "application/json" },
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
    });
    if (metaRes.status >= 200 && metaRes.status < 300 && !metaRes.truncated) {
      let meta: { myshopify_domain?: unknown } | null = null;
      try {
        meta = JSON.parse(metaRes.body.toString("utf8"));
      } catch {
        meta = null;
      }
      const fromMeta = myshopifyCandidate(meta?.myshopify_domain);
      if (fromMeta) return { myshopifyDomain: fromMeta, isShopify: true };
    }
    if (metaRes.headers["x-shopify-shop-id"]) detectedShopify = true;
  } catch {
    metaNetworkFailed = true;
  }

  // 3. Fallback: inspect the storefront root (bounded) for its myshopify domain.
  try {
    const rootRes = await safeFetch(`https://${domain}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OmniTarget/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      timeoutMs: 6000,
      maxBytes: 1_000_000,
    });

    const poweredBy = rootRes.headers["powered-by"] || "";
    if (rootRes.headers["x-shopify-shop-id"] || poweredBy.toLowerCase().includes("shopify")) detectedShopify = true;

    const html = rootRes.body.toString("utf8");
    const match = html.match(/([a-z0-9][a-z0-9-]*\.myshopify\.com)/i);
    const fromHtml = myshopifyCandidate(match?.[1]);
    if (fromHtml) return { myshopifyDomain: fromHtml, isShopify: true };

    if (detectedShopify || html.includes("window.Shopify") || html.includes("cdn.shopify.com")) {
      return { myshopifyDomain: null, isShopify: true, error: NEEDS_MYSHOPIFY };
    }
    return { myshopifyDomain: null, isShopify: false, error: NOT_DETECTED };
  } catch {
    if (detectedShopify) return { myshopifyDomain: null, isShopify: true, error: NEEDS_MYSHOPIFY };
    return { myshopifyDomain: null, isShopify: false, error: metaNetworkFailed ? UNREACHABLE : NOT_DETECTED };
  }
}
