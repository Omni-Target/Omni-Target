import { NextResponse } from "next/server";
import { captureBackgroundFailure } from "@/lib/observability/capture";
import { safeEqual } from "@/lib/shopify-oauth";
import { listOpenDeletionWork, processUnboundShopRedact, processWorkspaceDeletion } from "@/modules/workspaces/repository";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Retries shop data deletions that did not finish when shop/redact arrived
 * (Phase 1, task 3). Each step is idempotent, and a deletion completes only
 * once the database has verified nothing is left. Scheduled in vercel.json;
 * requires CRON_SECRET.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let work: Awaited<ReturnType<typeof listOpenDeletionWork>>;
  try {
    work = await listOpenDeletionWork();
  } catch (error) {
    captureBackgroundFailure("deletion-retry", error);
    return NextResponse.json({ error: "Could not list open deletions" }, { status: 500 });
  }

  let completed = 0;
  let failed = 0;
  const attempt = async (run: () => Promise<{ outcome: string }>) => {
    try {
      if ((await run()).outcome === "completed") completed++;
      else failed++;
    } catch (error) {
      failed++;
      captureBackgroundFailure("deletion-retry", error);
    }
  };

  for (const id of work.deletions) await attempt(() => processWorkspaceDeletion(id));
  for (const id of work.unboundRequests) await attempt(() => processUnboundShopRedact(id));

  if (failed > 0) captureBackgroundFailure("deletion-retry", new Error(`${failed} shop deletion(s) still unfinished`));
  return NextResponse.json({ open: work.deletions.length + work.unboundRequests.length, completed, failed });
}
