import { logger, schedules } from "@trigger.dev/sdk";
import { dispatchShopInsights, insightsWindow } from "@/modules/jobs/trigger";
import { shopsInsightsDue } from "@/modules/insights/repository";

/**
 * Every six hours (Phase 2, task 11): rebuilds the store snapshot of each shop
 * whose snapshot is missing or older than six hours, so its rolling windows
 * (last 30 and 60 days) stay current even without new orders.
 */
const MAX_AGE_SECONDS = 6 * 3_600;

export const insightsRefresh = schedules.task({
  id: "insights-refresh",
  // Each run starts at a stable time within 30 minutes of the cron time, spreading load.
  cron: { pattern: "50 */6 * * *", window: "30m" },
  maxDuration: 300,
  run: async () => {
    const due = await shopsInsightsDue(MAX_AGE_SECONDS, 200);
    let dispatched = 0;
    for (const shop of due) if (await dispatchShopInsights(shop.shop_domain, insightsWindow("schedule", Date.now(), MAX_AGE_SECONDS * 1000))) dispatched += 1;
    const report = { due: due.length, dispatched };
    logger.log("Insights refresh", report);
    return report;
  },
});
