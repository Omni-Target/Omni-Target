export async function resolveShopifyDomain(
  input: string
): Promise<{ 
  myshopifyDomain: string | null;
  isShopify: boolean;
  error?: string;
}> {
  // Clean the input
  let domain = input.trim()
    .replace("https://", "")
    .replace("http://", "")
    .replace("www.", "")
    .split("/")[0]
    .toLowerCase();

  // If already a myshopify.com domain, 
  // return immediately
  if (domain.includes("myshopify.com")) {
    return { 
      myshopifyDomain: domain, 
      isShopify: true 
    };
  }

  try {
    // Shopify stores expose their 
    // myshopify domain via their 
    // storefront API meta endpoint
    const res = await fetch(
      `https://${domain}/meta.json`,
      { 
        signal: AbortSignal.timeout(5000),
        headers: {
          "Accept": "application/json"
        }
      }
    );

    if (!res.ok) {
      return { 
        myshopifyDomain: null, 
        isShopify: false,
        error: "Could not reach this store. " +
          "Please check the URL."
      };
    }

    const meta = await res.json();

    // meta.json returns the myshopify 
    // domain in the domain field
    if (meta?.myshopify_domain) {
      return {
        myshopifyDomain: meta.myshopify_domain,
        isShopify: true
      };
    }

    // Fallback: check if Shopify headers 
    // are present
    const shopifyHeader = res.headers
      .get("x-shopify-shop-id");
      
    if (shopifyHeader) {
      return {
        myshopifyDomain: domain,
        isShopify: true
      };
    }

    return {
      myshopifyDomain: null,
      isShopify: false,
      error: "This doesn't appear to be " +
        "a Shopify store. Please check " +
        "the URL and try again."
    };

  } catch (err) {
    return {
      myshopifyDomain: null,
      isShopify: false,
      error: "Could not verify this store. " +
        "Please check the URL and try again."
    };
  }
}
