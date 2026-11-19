import { logger, schemaTask } from "@trigger.dev/sdk";
import { complianceExportPayload } from "@/modules/jobs/payloads";
import { runDataRequestExport } from "@/modules/compliance/data-requests";
import { liveDataRequestDeps } from "@/modules/compliance/live";

/**
 * Exports one customer data request (Phase 2, task 9). The export's claim lets
 * one run work on it at a time; a retry or a later dispatch resumes it, and a
 * withdrawn export (the customer was redacted) is never written. The run logs
 * counts only, never the customer's data.
 */
export const complianceExport = schemaTask({
  id: "compliance-data-request",
  schema: complianceExportPayload,
  maxDuration: 600,
  retry: { maxAttempts: 3, minTimeoutInMs: 10_000, maxTimeoutInMs: 120_000, factor: 2 },
  run: async ({ requestId }, { ctx }) => {
    const report = await runDataRequestExport(requestId, ctx.run.id, liveDataRequestDeps());
    logger.log("Customer data export run ended", { requestId, outcome: report.outcome, notified: report.notified ?? null, counts: report.counts ?? null });
    return report;
  },
});
