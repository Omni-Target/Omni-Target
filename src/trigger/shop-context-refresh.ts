import { logger, schedules } from "@trigger.dev/sdk";
import { syncShopContext } from "@/modules/insights/context-sync";
import { shopsContextDue } from "@/modules/insights/repository";

/**
 * Daily (Phase 3, task 5): reads the shop details and pre-spend datasets
 * (markets, delivery zones, policies, locales, analytics, discounts, marketing
 * history, storefront logo) of each imported shop whose stored context is
 * missing or more than 20 hours old. A shop that fails is reported and the
 * others go on; the insights worker also refreshes a context older than a day.
 */
const MAX_AGE_SECONDS = 20 * 3_600;

export const shopContextRefresh = schedules.task({
  id: "shop-context-refresh",
  cron: { pattern: "20 4 * * *", window: "30m" },
  maxDuration: 1_800,
  run: async () => {
    const due = await shopsContextDue(MAX_AGE_SECONDS, 500);
    const results: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const { shop_domain: shopDomain } of due) {
      try {
        results[shopDomain] = await syncShopContext(shopDomain);
      } catch (error) {
        failures.push(`${shopDomain}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
      }
    }
    logger.log("Shop context refresh", { due: due.length, failures: failures.length, results });
    if (failures.length) throw new Error(`Shop context refresh failed for ${failures.join("; ").slice(0, 900)}`);
    return { due: due.length, results };
  },
});
