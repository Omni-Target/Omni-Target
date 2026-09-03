import { auth } from "@clerk/nextjs/server";
import { randomBytes } from "crypto";

export async function GET(request: Request) {
  const { userId } = await auth();

  const { searchParams } = new URL(request.url);
  let shop = searchParams.get("shop")?.trim() || "";
  const from = searchParams.get("from") || (userId ? "onboarding" : "app_store");

  if (!shop && userId) {
    const { getUserIntegration } = await import("@/lib/db");
    const integration = await getUserIntegration(userId);
    shop = integration?.shopify_store_url || integration?.shop_domain || "";
  }

  if (!shop) {
    if (!userId) {
      const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, "");
      return Response.redirect(
        `${appBaseUrl}/login?error=missing_shop`
      );
    }
    return Response.json(
      { error: "Shop parameter required" },
      { status: 400 }
    );
  }

  // Clean and normalize shop input (supports custom domains like "allbirds.com", "brand", or "store.myshopify.com")
  shop = shop
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .toLowerCase();

  if (!shop.endsWith(".myshopify.com")) {
    if (!shop.includes(".")) {
      // User entered a plain store handle like "mybrand" or "omni-dev-zyvlsrxh"
      shop = `${shop}.myshopify.com`;
    } else {
      // User entered their custom website URL like "allbirds.com" or "shop.mybrand.co"
      try {
        const { resolveShopifyDomain } = await import("@/lib/shopify-resolver");
        const resolved = await resolveShopifyDomain(shop);
        if (resolved.isShopify && resolved.myshopifyDomain) {
          shop = resolved.myshopifyDomain;
        } else {
          // Fallback to domain prefix if meta endpoint is private or unreachable
          const brandSlug = shop.split(".")[0];
          shop = `${brandSlug}.myshopify.com`;
        }
      } catch (resolveErr) {
        console.warn("Domain resolution error, falling back to brand slug:", resolveErr);
        const brandSlug = shop.split(".")[0];
        shop = `${brandSlug}.myshopify.com`;
      }
    }
  }

  // Generate nonce for security and encode user state
  const nonce = randomBytes(16).toString("hex");
  const state = `${nonce}___${from}___${userId || "anonymous"}`;

  // Store state in cookie for verification
  const response = new Response(null, {
    status: 302,
    headers: {
      "Set-Cookie":
        `shopify_oauth_state=${state}; ` +
        `HttpOnly; Secure; SameSite=Lax; ` +
        `Max-Age=600; Path=/`,
    }
  });

  const scopes = [
    "read_orders",
    "read_all_orders",
    "read_customers",
    "read_products",
    "read_product_listings",
    "read_inventory"
  ].join(",");

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin)
    .replace(/\/$/, "");

  const redirectUri =
    `${appUrl}/api/auth/shopify/callback`;

  // Standard offline token OAuth flow — no grant_options needed.
  // The expiring=1 parameter is passed during the token exchange
  // in the callback route, not here.
  const authUrl =
    `https://${shop}/admin/oauth/authorize?` +
    `client_id=${process.env.SHOPIFY_CLIENT_ID}` +
    `&scope=${scopes}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  response.headers.set("Location", authUrl);
  return response;
}
