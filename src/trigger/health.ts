import { logger, task } from "@trigger.dev/sdk";

/**
 * Confirms the worker runs and can be triggered. Reports its runtime and
 * nothing else: no environment values, no data.
 */
export const healthCheck = task({
  id: "health-check",
  maxDuration: 60,
  run: async (payload: { note?: string }) => {
    const result = { ok: true, node: process.version, at: new Date().toISOString(), note: payload?.note ?? null };
    logger.log("Worker health check", result);
    return result;
  },
});
