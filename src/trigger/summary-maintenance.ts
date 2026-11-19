import { logger, schedules } from "@trigger.dev/sdk";
import { maintainSummaries } from "@/modules/retention/maintenance";

/**
 * Summary maintenance (Phase 2, task 8; decision 6): every six hours, each
 * due month in its own database call (see modules/retention/maintenance).
 * Changed final months get adjustments, open months are rebuilt and months
 * 120 days old are finalised. Months left when the budget runs out stay due;
 * a run with failed months fails, so it reaches Sentry (src/trigger/init.ts)
 * with the shops and months, and nothing more.
 */
export const summaryMaintenance = schedules.task({
  id: "summary-maintenance",
  // Each run starts at a stable time within 30 minutes of the cron time, spreading load.
  cron: { pattern: "20 */6 * * *", window: "30m" },
  maxDuration: 900,
  retry: { maxAttempts: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 120_000, factor: 2 },
  run: async () => {
    const report = await maintainSummaries({ budgetMs: 780_000 });
    logger.log("Summary maintenance", {
      due: report.due, refreshed: report.refreshed, skipped: report.skipped, deferred: report.deferred,
      productAdjustments: report.adjustments.product, storeAdjustments: report.adjustments.store,
    });
    if (report.failures.length) {
      throw new Error(`Summary maintenance failed for ${report.failures.map((f) => `${f.shop} ${f.month}: ${f.error}`).join("; ").slice(0, 900)}`);
    }
    return report;
  },
});
