import { NextResponse } from "next/server";
import { captureBackgroundFailure } from "@/lib/observability/capture";
import { safeEqual } from "@/lib/shopify-oauth";
import { shopsInsightsDue } from "@/modules/insights/repository";
import { dispatchShopInsights, insightsWindow } from "@/modules/jobs/trigger";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Asks the worker to rebuild the store snapshots that are due (Phase 2, task
 * 11). The insights-refresh schedule does this every six hours; this route is
 * a manual trigger with CRON_SECRET. It never syncs with Shopify itself.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const due = await shopsInsightsDue(4 * 3_600, 100);
    let dispatched = 0;
    for (const shop of due) if (await dispatchShopInsights(shop.shop_domain, insightsWindow("cron"))) dispatched += 1;
    return NextResponse.json({ due: due.length, dispatched });
  } catch (error) {
    captureBackgroundFailure("sync-stores", error);
    return NextResponse.json({ error: "Snapshot refresh failed" }, { status: 500 });
  }
}
