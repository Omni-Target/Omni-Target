import { logger, schemaTask, wait } from "@trigger.dev/sdk";
import { shopImportPayload } from "@/modules/jobs/payloads";
import { runShopImport } from "@/modules/ingestion/workflow";
import { dispatchShopInsights } from "@/modules/jobs/trigger";
import { syncShopContext } from "@/modules/insights/context-sync";

/**
 * The initial import of one shop (Phase 2, task 6). One run per shop at a
 * time (the shop's domain is the concurrency key). Retries resume from each
 * domain's checkpoint; a run that finds the import finished or owned by a
 * live run does nothing. Waits between polls are durable (wait.for), so a
 * long bulk operation costs no compute.
 */
export const shopImport = schemaTask({
  id: "shop-import",
  schema: shopImportPayload,
  concurrency: { perKey: 1 },
  maxDuration: 3_600,
  retry: { maxAttempts: 3, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async ({ importId, shopDomain }, { ctx }) => {
    const sleep = async (ms: number) => {
      if (ms >= 5_000) await wait.for({ seconds: Math.ceil(ms / 1000) });
      else await new Promise((resolve) => setTimeout(resolve, ms));
    };
    const report = await runShopImport(importId, ctx.run.id, sleep);
    logger.log("Shop import run ended", { shop: shopDomain, outcome: report.outcome });
    // The shop's context (Phase 3, task 5), then the store snapshot from what the import wrote (task 11).
    if (report.outcome === "succeeded" || report.outcome === "partial") {
      const context = await syncShopContext(shopDomain).catch((error) => ({ outcome: "failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
      logger.log("Shop context after import", { shop: shopDomain, ...context });
      await dispatchShopInsights(shopDomain, `import-${importId}`);
    }
    return report;
  },
});
