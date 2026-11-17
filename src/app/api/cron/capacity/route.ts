import { NextResponse } from "next/server";
import { captureBackgroundFailure, captureOperationalAlert } from "@/lib/observability/capture";
import { safeEqual } from "@/lib/shopify-oauth";
import { capacityLevel, quotaBytes } from "@/modules/capacity/policy";
import { captureCapacitySnapshot } from "@/modules/capacity/repository";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Daily capacity snapshot (Phase 1, task 10): records the database's size and
 * its largest tables, and alerts in Sentry at 60% (warning) and 75% (error) of
 * the plan's quota (DATABASE_QUOTA_MB). Scheduled in vercel.json; requires
 * CRON_SECRET.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let quota: number;
  let snapshot: Awaited<ReturnType<typeof captureCapacitySnapshot>>;
  try {
    quota = quotaBytes();
    snapshot = await captureCapacitySnapshot(quota);
  } catch (error) {
    captureBackgroundFailure("capacity-snapshot", error);
    return NextResponse.json({ error: "Capacity snapshot failed" }, { status: 500 });
  }

  const level = capacityLevel(snapshot.database_bytes, quota);
  if (level !== "ok") {
    const percent = Math.round((snapshot.database_bytes / quota) * 100);
    captureOperationalAlert(
      "capacity-snapshot",
      `Database at ${percent}% of its ${Math.round(quota / 1048576)} MB quota`,
      level === "critical" ? "error" : "warning",
      { database_bytes: snapshot.database_bytes, quota_bytes: quota, largest: snapshot.largest },
    );
  }
  return NextResponse.json({ level, used_share: snapshot.used_share, database_bytes: snapshot.database_bytes, quota_bytes: quota });
}
