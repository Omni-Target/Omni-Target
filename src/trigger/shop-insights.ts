import { logger, schemaTask } from "@trigger.dev/sdk";
import { shopInsightsPayload } from "@/modules/jobs/payloads";
import { computeShopInsights } from "@/modules/insights/live";

/**
 * One shop's store snapshot, built from the canonical mirror (Phase 2, task
 * 11). One run per shop at a time (the shop's domain is the concurrency key).
 * Requested after imports, after sync runs that changed orders or products, by
 * the refresh schedule, and when a merchant asks for a refresh.
 */
export const shopInsights = schemaTask({
  id: "shop-insights",
  schema: shopInsightsPayload,
  concurrency: { perKey: 1 },
  machine: "small-2x",
  maxDuration: 600,
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async ({ shopDomain }) => {
    const report = await computeShopInsights(shopDomain);
    logger.log("Shop insights", { shop: shopDomain, ...report });
    return report;
  },
});
