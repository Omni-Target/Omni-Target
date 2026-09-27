import { clerkClient } from "@clerk/nextjs/server";
import { requireUser } from "@/lib/api/require-user";
import { getUserIntegration } from "@/lib/db";
import { fetchShopifyStoreLogo } from "@/lib/shopify-store-logo";

export async function POST() {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;

  const integration = await getUserIntegration(authResult.userId);
  const shop = integration?.shopify_store_url || integration?.shop_domain;
  if (!shop) return Response.json({ logoUrl: null }, { headers: { "Cache-Control": "no-store" } });

  const logoUrl = await fetchShopifyStoreLogo(shop, integration?.shopify_custom_domain);
  if (logoUrl) {
    const clerk = await clerkClient();
    const updates: Record<string, unknown> = { storeLogoUrl: logoUrl };
    if (shop) updates.shopifyStoreUrl = shop;
    await clerk.users.updateUserMetadata(authResult.userId, {
      publicMetadata: updates,
    });
  }

  return Response.json({ logoUrl }, { headers: { "Cache-Control": "no-store" } });
}
