import { logger, schemaTask } from "@trigger.dev/sdk";
import { shopAccessCheckPayload } from "@/modules/jobs/payloads";
import { checkShopAccess } from "@/modules/ingestion/access-check";
import { ensureShopSubscriptions } from "@/modules/ingestion/sync-live";

/**
 * Records what a shop granted (Phase 2, task 1) in shop_access. Runs after
 * every install and before every import. One run per shop at a time: callers
 * trigger it with the shop's domain as the concurrency key.
 */
export const shopAccessCheck = schemaTask({
  id: "shop-access-check",
  schema: shopAccessCheckPayload,
  concurrency: { perKey: 1 },
  maxDuration: 120,
  run: async ({ shopDomain, reason }) => {
    const result = await checkShopAccess(shopDomain);
    if (result.outcome !== "checked") {
      logger.warn("Shop access not checked", { shop: shopDomain, reason, outcome: result.outcome });
      return { outcome: result.outcome };
    }
    const domains = Object.fromEntries(Object.entries(result.report.domains).map(([name, entry]) => [name, entry.status]));
    logger.log("Shop access checked", { shop: shopDomain, reason, domains, withheld: Object.keys(result.report.withheldFields) });
    // The incremental sync's webhooks (task 10), on install and reconnect; the daily reconcile keeps them right too.
    const subscriptions = reason === "install" || reason === "reconnect" ? await ensureShopSubscriptions(shopDomain).catch((error: unknown) => ({
      failed: [{ topic: "*", error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }],
    })) : null;
    if (subscriptions) logger.log("Sync subscriptions", { shop: shopDomain, subscriptions });
    return { outcome: result.outcome, domains, orderHistory: result.report.domains.orders.history?.basis ?? null, subscriptions };
  },
});
