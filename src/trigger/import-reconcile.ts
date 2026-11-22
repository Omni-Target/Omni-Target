import { logger, schedules } from "@trigger.dev/sdk";
import { reconcileImports } from "@/modules/ingestion/reconcile";

/**
 * Every ten minutes (Phase 2, task 6): re-dispatches imports whose dispatch
 * failed or whose run went quiet, closes imports out of attempts, and sweeps
 * expired staging files. Runs in Trigger.dev because Vercel's Hobby plan
 * allows only daily cron jobs; the Vercel route keeps a daily run as an
 * independent backstop (vercel.json).
 */
export const importReconcile = schedules.task({
  id: "import-reconcile",
  cron: { pattern: "*/10 * * * *", window: "2m" },
  maxDuration: 300,
  run: async () => {
    const report = await reconcileImports();
    logger.log("Import reconcile", { ...report });
    return report;
  },
});
