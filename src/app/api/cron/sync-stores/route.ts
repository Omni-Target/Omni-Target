import { NextResponse } from "next/server";
import { supabaseAdmin, updateUserIntegration } from "@/lib/db";
import { getValidShopifyToken } from "@/lib/shopify-token";
import { fetchShopifyStoreData } from "@/lib/connectors/shopify";

export const maxDuration = 60; // 60 seconds
export const runtime = "nodejs";

/**
 * Periodic background store synchronizer. Runs on a scheduled Vercel cron
 * to keep merchant orders, product inventory, and ad-readiness metrics fresh
 * so founders never have to manually click "Sync store data".
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find stores that have connected Shopify and haven't synced in 4+ hours,
    // prioritizing the ones that haven't been synced in the longest time.
    const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString();

    const { data: integrations, error: fetchErr } = await supabaseAdmin
      .from("user_integrations")
      .select("clerk_user_id, shopify_store_url, shop_domain, store_snapshot_at")
      .or("shopify_store_url.not.is.null,shop_domain.not.is.null")
      .or(`store_snapshot_at.is.null,store_snapshot_at.lte.${fourHoursAgo}`)
      .order("store_snapshot_at", { ascending: true, nullsFirst: true })
      .limit(10); // Batch size to stay comfortably within 60s execution window

    if (fetchErr || !integrations) {
      console.error("[Cron:sync-stores] Error fetching integrations:", fetchErr);
      return NextResponse.json(
        { error: "Failed to fetch integrations" },
        { status: 500 }
      );
    }

    let syncedCount = 0;
    let skippedCount = 0;

    for (const integration of integrations) {
      const userId = integration.clerk_user_id;
      if (!userId) {
        skippedCount++;
        continue;
      }

      try {
        const tokenResult = await getValidShopifyToken(userId);
        if (tokenResult.status !== "ok") {
          skippedCount++;
          continue;
        }

        const storeData = await fetchShopifyStoreData(
          tokenResult.shopUrl,
          tokenResult.accessToken,
          userId
        );

        await updateUserIntegration(userId, {
          store_snapshot: storeData,
          store_snapshot_at: new Date().toISOString(),
        });

        syncedCount++;
        console.log(
          `[Cron:sync-stores] Successfully auto-synced store for user: ${userId}`
        );
      } catch (storeErr) {
        console.error(
          `[Cron:sync-stores] Sync failed for user ${userId}:`,
          storeErr
        );
        skippedCount++;
      }
    }

    return NextResponse.json({
      success: true,
      processed: integrations.length,
      synced: syncedCount,
      skipped: skippedCount,
    });
  } catch (err) {
    console.error("[Cron:sync-stores] Fatal error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
