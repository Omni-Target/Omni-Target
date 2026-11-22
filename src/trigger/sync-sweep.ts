import { logger, schedules } from "@trigger.dev/sdk";
import { dispatchShopSync } from "@/modules/jobs/trigger";
import { syncShopsDue } from "@/modules/ingestion/sync-repository";

/**
 * Every ten minutes (Phase 2, task 10): dispatches the sync worker for every
 * shop with events waiting (a dispatch that failed, events due for a retry, a
 * run that went quiet), and reports dead events.
 */
export const syncSweep = schedules.task({
  id: "sync-sweep",
  cron: { pattern: "*/10 * * * *", window: "2m" },
  maxDuration: 120,
  run: async () => {
    const shops = await syncShopsDue(200);
    const bucket = `sweep-${Math.floor(Date.now() / 600_000)}`;
    let dispatched = 0;
    for (const shop of shops) if (await dispatchShopSync(shop.shop_domain, bucket, 15_000)) dispatched += 1;
    const dead = shops.reduce((n, shop) => n + shop.dead, 0);
    if (dead) logger.warn("Dead sync events", { shops: shops.filter((s) => s.dead).map((s) => ({ shop: s.shop_domain, dead: s.dead })) });
    logger.log("Sync sweep", { due: shops.length, dispatched, dead });
    return { due: shops.length, dispatched, dead };
  },
});
