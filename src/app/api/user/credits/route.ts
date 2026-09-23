import { auth } from "@clerk/nextjs/server";
import { queryUserIntegrationSelect } from "@/lib/db";
import { availableCredits } from "@/lib/credit-balance";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: NO_CACHE_HEADERS,
      }
    );
  }

  const { detectColumns } = await import("@/lib/billing-db");
  const cols = await detectColumns();

  const selectQuery = [
    cols.hasCredits ? "credits" : "credits_balance",
    "credits_balance",
    "credits_unlimited_until",
    cols.hasShopDomain ? "shop_domain" : "shopify_store_url",
    "shopify_store_url",
  ].join(", ");

  const data = await queryUserIntegrationSelect(userId, selectQuery);

  const isUnlimited =
    data?.credits_unlimited_until &&
    new Date(data.credits_unlimited_until) > new Date();

  const shop = data
    ? (cols.hasShopDomain ? data.shop_domain : data.shopify_store_url) || data.shopify_store_url
    : null;

  const credits = availableCredits(data, cols.hasCredits);

  const payload = {
    credits_balance: credits,
    shop: shop || null,
    is_unlimited: !!isUnlimited,
    unlimited_until: data?.credits_unlimited_until || null,
  };

  return Response.json(payload, {
    headers: NO_CACHE_HEADERS,
  });
}
