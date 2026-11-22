import { logger, schemaTask } from "@trigger.dev/sdk";
import { shopSyncPayload } from "@/modules/jobs/payloads";
import { processShopEvents } from "@/modules/ingestion/sync";
import { liveSyncDeps } from "@/modules/ingestion/sync-live";

/**
 * Drains one shop's sync inbox (Phase 2, task 10): fetches each changed
 * resource from Shopify by ID and writes its current state. One run per shop
 * at a time (the shop's domain is the concurrency key). Events a run cannot
 * finish are retried with backoff by later runs.
 */
export const shopSyncEvents = schemaTask({
  id: "sync-shop-events",
  schema: shopSyncPayload,
  concurrency: { perKey: 1 },
  maxDuration: 600,
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async ({ shopDomain }, { ctx }) => {
    const report = await processShopEvents(shopDomain, ctx.run.id, liveSyncDeps());
    logger.log("Shop sync", { shop: shopDomain, ...report });
    return report;
  },
});
