export async function resolveShopifyDomain(
  input: string
): Promise<{ 
  myshopifyDomain: string | null;
  isShopify: boolean;
  error?: string;
}> {
  // Clean the input: trim, remove protocol, www, paths, queries, and ports
  const domain = input.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0]
    .toLowerCase();

  if (!domain) {
    return {
      myshopifyDomain: null,
      isShopify: false,
      error: "Please enter your store website.",
    };
  }

  // 1. Direct .myshopify.com domain check:
  // Pre-flight verify that the Shopify store actually exists before redirecting to OAuth.
  // Nonexistent .myshopify.com subdomains return HTTP 404 from Shopify edge.
  if (domain.includes("myshopify.com")) {
    try {
      const res = await fetch(`https://${domain}`, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });

      // Shopify explicitly returns 404 when a subdomain has not been registered or created
      if (res.status === 404) {
        return {
          myshopifyDomain: null,
          isShopify: false,
          error: "This Shopify store could not be found. Please check your store name or URL.",
        };
      }

      // Valid store subdomains return 200, 301, 302, 303, 307, 308, 401, or 403
      return {
        myshopifyDomain: domain,
        isShopify: true,
      };
    } catch {
      // Network or DNS failure
      return {
        myshopifyDomain: null,
        isShopify: false,
        error: "Could not reach this website. Please verify your domain and internet connection.",
      };
    }
  }

  // 2. Custom domain check:
  // Attempt to resolve storefront meta or inspect headers/HTML.
  let metaRes: Response | null = null;
  let metaNetworkFailed = false;

  try {
    metaRes = await fetch(`https://${domain}/meta.json`, {
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: "application/json",
      },
    });

    if (metaRes.ok) {
      const meta = await metaRes.json().catch(() => null);
      if (meta?.myshopify_domain) {
        return {
          myshopifyDomain: meta.myshopify_domain,
          isShopify: true,
        };
      }
    }

    const shopifyHeader = metaRes.headers.get("x-shopify-shop-id");
    if (shopifyHeader) {
      return {
        myshopifyDomain: domain,
        isShopify: true,
      };
    }
  } catch {
    metaNetworkFailed = true;
  }

  // Fallback: check root storefront domain
  try {
    const rootRes = await fetch(`https://${domain}`, {
      method: "GET",
      signal: AbortSignal.timeout(6000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OmniTarget/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    // Check Shopify response headers
    const shopId = rootRes.headers.get("x-shopify-shop-id");
    const poweredBy = rootRes.headers.get("powered-by");
    if (shopId || (poweredBy && poweredBy.toLowerCase().includes("shopify"))) {
      return {
        myshopifyDomain: domain,
        isShopify: true,
      };
    }

    // Inspect body for Shopify indicators
    const html = await rootRes.text().catch(() => "");
    const match = html.match(/([a-zA-Z0-9-]+\.myshopify\.com)/i);
    if (match) {
      return {
        myshopifyDomain: match[1].toLowerCase(),
        isShopify: true,
      };
    }

    if (html.includes("window.Shopify") || html.includes("cdn.shopify.com")) {
      return {
        myshopifyDomain: domain,
        isShopify: true,
      };
    }

    // The site is reachable (rootRes succeeded), but is not a Shopify store
    return {
      myshopifyDomain: null,
      isShopify: false,
      error:
        "We could not detect a Shopify store at this domain. Please verify your store URL or enter your .myshopify.com address.",
    };
  } catch {
    // If meta also failed with a network error, the domain is unreachable
    if (metaNetworkFailed) {
      return {
        myshopifyDomain: null,
        isShopify: false,
        error: "Could not reach this website. Please verify your domain and internet connection.",
      };
    }

    // If metaRes connected earlier (e.g. returned 404) but root GET timed out / failed
    return {
      myshopifyDomain: null,
      isShopify: false,
      error:
        "We could not detect a Shopify store at this domain. Please verify your store URL or enter your .myshopify.com address.",
    };
  }
}
