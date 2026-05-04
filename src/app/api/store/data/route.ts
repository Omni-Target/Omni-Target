import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchShopifyStoreData } from "@/lib/connectors/shopify";

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

  console.log("Fetching store data for userId:", userId);

  // Verify we can write to the table
  const { data: testRow } = await supabaseAdmin
    .from("user_integrations")
    .select("id, store_snapshot_at")
    .eq("clerk_user_id", userId!)
    .single();
    
  console.log("Existing row:", testRow);

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

  // TODO: Re-enable cache after confirming snapshot saves correctly
  /*
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
  */


  try {
    const storeData = await fetchShopifyStoreData(
      integration.shopify_store_url,
      integration.shopify_access_token
    );

    console.log("Attempting to cache store data for userId:", userId);
    console.log("Store data to cache:", 
      JSON.stringify({
        store: storeData.store,
        orderCount: storeData.orders.orders_last_30_days,
        productCount: storeData.products.length
      })
    );

    // Save to Supabase without awaiting
    // This runs after the response is sent
    supabaseAdmin
      .from("user_integrations")
      .update({ 
        store_snapshot: storeData,
        store_snapshot_at: new Date().toISOString()
      })
      .eq("clerk_user_id", userId!)
      .then(({ error }) => {
        if (error) {
          console.error("Snapshot save failed:", error);
        } else {
          console.log("Snapshot saved successfully");
        }
      });

    // Return immediately without waiting 
    // for the save
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
