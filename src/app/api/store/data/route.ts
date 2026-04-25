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
      "shopify_store_url, shopify_access_token, shopify_custom_domain"
    )
    .eq("clerk_user_id", userId)
    .single();

  if (!integration?.shopify_access_token) {
    return Response.json({
      connected: false,
      message: "Shopify store not connected",
    });
  }

  try {
    const storeData = await fetchShopifyStoreData(
      integration.shopify_store_url,
      integration.shopify_access_token
    );

    // Cache in Supabase for 24 hours
    await supabaseAdmin
      .from("user_integrations")
      .update({
        store_snapshot: storeData,
        store_snapshot_at: new Date().toISOString(),
      })
      .eq("clerk_user_id", userId);

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
