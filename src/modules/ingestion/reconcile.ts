import "server-only";
import { dispatchShopImport } from "@/modules/jobs/trigger";
import { createLogger } from "@/platform/logger";
import { discardHistory, finishImport, importsNeedingDispatch } from "./imports";
import { r2StagingStore, sweepStaged } from "./staging";

/**
 * Durable reconciliation of import dispatches (Phase 2, task 6). Runs from a
 * Vercel cron, independent of Trigger.dev, so it recovers both a dispatch that
 * never reached Trigger.dev and a run that died without finishing:
 * - requested but not dispatched after a grace period: dispatched again;
 * - dispatched or running with no heartbeat for 15 minutes: dispatched again
 *   (the new run takes the import over; the old one, if alive, stops);
 * - after MAX_DISPATCHES the import is closed as failed and its staged
 *   history discarded.
 * It also sweeps temporary R2 staging older than the result lifetime.
 */
const log = createLogger({ module: "import-reconcile" });
export const DISPATCH_GRACE_SECONDS = 120;
export const STALE_SECONDS = 900;
export const MAX_DISPATCHES = 10;

export interface ReconcileReport {
  examined: number;
  dispatched: number;
  undispatched: number;
  abandoned: number;
  staging: { deleted: number; remaining: number } | { error: string };
}

export async function reconcileImports(): Promise<ReconcileReport> {
  const due = await importsNeedingDispatch(DISPATCH_GRACE_SECONDS, STALE_SECONDS);
  const report: ReconcileReport = { examined: due.length, dispatched: 0, undispatched: 0, abandoned: 0, staging: { deleted: 0, remaining: 0 } };
  for (const item of due) {
    if (item.dispatch_attempts >= MAX_DISPATCHES) {
      await finishImport(item.import_id, null, "failed", null, "dispatch_exhausted");
      await discardHistory(item.import_id, null).catch(() => 0);
      report.abandoned += 1;
      log.warn("Shop import abandoned after repeated dispatches", { shop: item.shop_domain, importId: item.import_id });
      continue;
    }
    // No user waits here: allow the API time, so an accepted dispatch is not misreported.
    const runId = await dispatchShopImport(item.import_id, item.shop_domain, item.dispatch_attempts + 1, 15_000);
    if (runId) report.dispatched += 1;
    else report.undispatched += 1;
  }
  try {
    report.staging = await sweepStaged(r2StagingStore());
  } catch (error) {
    report.staging = { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" };
  }
  return report;
}
