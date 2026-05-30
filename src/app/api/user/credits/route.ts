import { auth } from "@clerk/nextjs/server";
import { queryUserIntegrationSelect } from "@/lib/db";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { detectColumns } = await import("@/lib/billing-db");
  const cols = await detectColumns();

  const selectQuery = [
    cols.hasCredits ? "credits" : "credits_balance",
    "credits_balance",
    "credits_unlimited_until",
    cols.hasShopDomain ? "shop_domain" : "shopify_store_url",
    "shopify_store_url"
  ].join(", ");

  const data = await queryUserIntegrationSelect(userId, selectQuery);

  const isUnlimited =
    data?.credits_unlimited_until &&
    new Date(data.credits_unlimited_until) > new Date();

  const shop = data 
    ? (cols.hasShopDomain ? data.shop_domain : data.shopify_store_url) || data.shopify_store_url 
    : null;

  const credits = data 
    ? (cols.hasCredits ? data.credits : data.credits_balance) ?? data.credits_balance ?? 0
    : 0;

  return Response.json({
    credits_balance: credits,
    shop: shop || null,
    is_unlimited: !!isUnlimited,
    unlimited_until: data?.credits_unlimited_until || null,
  });
}
