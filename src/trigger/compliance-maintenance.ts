import * as Sentry from "@sentry/node";
import { logger, schedules } from "@trigger.dev/sdk";
import { maintainComplianceExports } from "@/modules/compliance/data-requests";
import { liveMaintenanceDeps } from "@/modules/compliance/live";

const LEVELS = { 1: "10 days or less", 2: "3 days or less", 3: "overdue" } as const;

/**
 * Hourly upkeep of customer data requests (Phase 2, task 9): withdrawals and
 * file deletions after redactions, expiry after 30 days, notification retries,
 * re-dispatch of stalled exports, and deadline escalation to Sentry (warning
 * with 10 days left, error with 3 days left and when overdue), each level once.
 * A run with failed actions fails, so it reaches Sentry too (src/trigger/init.ts).
 */
export const complianceMaintenance = schedules.task({
  id: "compliance-maintenance",
  cron: { pattern: "40 * * * *", window: "10m" },
  maxDuration: 600,
  run: async () => {
    const report = await maintainComplianceExports(liveMaintenanceDeps(async (level, context) => {
      Sentry.captureMessage(`Customer data request not yet provided: deadline ${LEVELS[level]}`, {
        level: level === 1 ? "warning" : "error",
        tags: { job: "compliance-deadline", shop: context.shopDomain },
        extra: { compliance_request_id: context.requestId, due_at: context.dueAt },
      });
      await Sentry.flush(2_000);
    }));
    logger.log("Compliance maintenance", { ...report, failures: report.failures.length });
    if (report.failures.length) {
      throw new Error(`Compliance maintenance failed: ${report.failures.map((f) => `${f.action} ${f.requestId}: ${f.error}`).join("; ").slice(0, 900)}`);
    }
    return report;
  },
});
