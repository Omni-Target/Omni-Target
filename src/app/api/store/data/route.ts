import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchShopifyStoreData } from "@/lib/connectors/shopify";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { data: integration } = await supabaseAdmin
    .from("user_integrations")
    .select(
      "shopify_store_url, shopify_access_token, shopify_custom_domain, store_snapshot, store_snapshot_at"
    )
    .eq("clerk_user_id", userId)
    .single();

  if (!integration?.shopify_access_token) {
    return Response.json({
      connected: false,
      message: "Shopify store not connected",
    });
  }

  // Check if cache is fresh (< 6 hours)
  const cacheAge = integration?.store_snapshot_at
    ? Date.now() - new Date(integration.store_snapshot_at).getTime()
    : Infinity;

  const SIX_HOURS = 6 * 60 * 60 * 1000;

  if (integration?.store_snapshot && cacheAge < SIX_HOURS) {
    console.log("Returning cached store data");
    return Response.json({
      connected: true,
      data: integration.store_snapshot,
      cached: true
    });
  }


  try {
    const storeData = await fetchShopifyStoreData(
      integration.shopify_store_url,
      integration.shopify_access_token
    );

    // Cache in Supabase for 24 hours
    const { error: cacheError } = await supabaseAdmin
      .from("user_integrations")
      .update({
        store_snapshot: storeData,
        store_snapshot_at: new Date().toISOString(),
      })
      .eq("clerk_user_id", userId);

    if (cacheError) {
      console.error("Cache save error:", cacheError);
    }

    return Response.json({
      connected: true,
      data: storeData,
    });
  } catch (error) {
    console.error("Store data error:", error);
    return Response.json(
      { error: "Failed to fetch store data" },
      { status: 500 }
    );
  }
}
