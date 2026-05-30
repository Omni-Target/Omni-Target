import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { randomBytes } from "crypto";

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  let shop = searchParams.get("shop");
  const from = searchParams.get("from") || "";

  if (!shop) {
    const { getUserIntegration } = await import("@/lib/db");
    const integration = await getUserIntegration(userId);
    shop = integration?.shopify_store_url || integration?.shop_domain;
  }

  if (!shop) {
    return Response.json(
      { error: "Shop parameter required" },
      { status: 400 }
    );
  }

  // Generate nonce for security
  const nonce = randomBytes(16).toString("hex");
  const state = `${nonce}___${from}`;

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

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "")
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
