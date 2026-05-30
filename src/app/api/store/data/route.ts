import { auth } from "@clerk/nextjs/server";
import { getUserIntegration, updateUserIntegration } from "@/lib/db";
import { fetchShopifyStoreData } from "@/lib/connectors/shopify";
import { getValidShopifyToken } from "@/lib/shopify-token";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Requires Vercel Pro — falls back to 10s on free tier

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  console.log("Store data request from userId:", userId);

  // Get credits info regardless of token status
  const creditsRow = await getUserIntegration(userId);

  // Get a valid (auto-refreshed) Shopify token
  const tokenResult = await getValidShopifyToken(userId);

  if (!tokenResult) {
    return Response.json({
      connected: false,
      message: "Shopify store not connected",
      credits_balance: creditsRow?.credits_balance || 0,
      credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
    });
  }

  try {
    const storeData = await fetchShopifyStoreData(
      tokenResult.shopUrl,
      tokenResult.accessToken
    );

    console.log("Store data fetched:", {
      store: storeData.store,
      orderCount: storeData.orders.orders_last_30_days,
      productCount: storeData.products.length
    });

    // Save snapshot to Supabase
    try {
      await updateUserIntegration(userId!, {
        store_snapshot: storeData,
        store_snapshot_at: new Date().toISOString()
      });
      console.log("Snapshot saved successfully");
    } catch (error) {
      console.error("Snapshot save failed:", error);
    }

    return Response.json({
      connected: true,
      data: storeData,
      credits_balance: creditsRow?.credits_balance || 0,
      credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
    });
  } catch (error) {
    console.error("Store data error:", error);
    return Response.json(
      { error: "Failed to fetch store data" },
      { status: 500 }
    );
  }
}
