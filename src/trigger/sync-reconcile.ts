import { logger, schedules } from "@trigger.dev/sdk";
import { dispatchShopSync } from "@/modules/jobs/trigger";
import { reconcileShopUpdates } from "@/modules/ingestion/sync";
import { ensureShopSubscriptions, liveReconcileDeps, refreshCatalogReferences } from "@/modules/ingestion/sync-live";
import { reconcilableShops } from "@/modules/ingestion/sync-repository";

/**
 * Daily reconcile (Phase 2, task 10): for each imported shop, keeps its sync
 * subscriptions right and records the orders, products and customers updated
 * since each watermark as events, so a missed webhook is repaired; then
 * dispatches the sync worker; and refreshes the catalog's definitions and
 * referenced metaobjects (Phase 3). A shop that fails is reported and the others go on.
 */
export const syncReconcile = schedules.task({
  id: "sync-reconcile",
  cron: { pattern: "30 3 * * *", window: "30m" },
  maxDuration: 1_800,
  run: async () => {
    const results: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const shopDomain of await reconcilableShops()) {
      try {
        const subscriptions = await ensureShopSubscriptions(shopDomain);
        const reconciled = await reconcileShopUpdates(shopDomain, liveReconcileDeps());
        const recorded = "skipped" in reconciled ? 0 : Object.values(reconciled).reduce((n, d) => n + d.recorded, 0);
        if (recorded) await dispatchShopSync(shopDomain, `reconcile-${new Date().toISOString().slice(0, 10)}`, 15_000);
        const references = await refreshCatalogReferences(shopDomain);
        results[shopDomain] = { subscriptions, reconciled, references };
      } catch (error) {
        failures.push(`${shopDomain}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
      }
    }
    logger.log("Sync reconcile", { shops: Object.keys(results).length, failures: failures.length, results });
    if (failures.length) throw new Error(`Sync reconcile failed for ${failures.join("; ").slice(0, 900)}`);
    return results;
  },
});
