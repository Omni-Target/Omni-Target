import { NextResponse } from "next/server";
import { captureBackgroundFailure, captureOperationalAlert } from "@/lib/observability/capture";
import { safeEqual } from "@/lib/shopify-oauth";
import { reconcileImports } from "@/modules/ingestion/reconcile";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Re-dispatches shop imports whose dispatch failed or whose run died (Phase 2,
 * task 6), and sweeps temporary R2 staging. Called by Vercel cron with
 * CRON_SECRET.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const report = await reconcileImports();
    if (report.abandoned > 0 || report.undispatched > 0) {
      captureOperationalAlert("import-reconcile", "Shop imports could not be dispatched", "warning", { ...report });
    }
    return NextResponse.json(report);
  } catch (error) {
    captureBackgroundFailure("import-reconcile", error);
    return NextResponse.json({ error: "Reconcile failed" }, { status: 500 });
  }
}
