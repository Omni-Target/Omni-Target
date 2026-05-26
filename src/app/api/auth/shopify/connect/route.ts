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
  const shop = searchParams.get("shop");

  if (!shop) {
    return Response.json(
      { error: "Shop parameter required" },
      { status: 400 }
    );
  }

  // Generate nonce for security
  const state = randomBytes(16).toString("hex");

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
    "read_customers",
    "read_products",
    "read_product_listings",
    "read_collections",
    "read_inventory"
  ].join(",");

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "")
    .replace(/\/$/, "");
  // Remove trailing slash if present

  const redirectUri =
    `${appUrl}/api/auth/shopify/callback`;

  const authUrl =
    `https://${shop}/admin/oauth/authorize?` +
    `client_id=${process.env.SHOPIFY_CLIENT_ID}` +
    `&scope=${scopes}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  response.headers.set("Location", authUrl);
  return response;
}
