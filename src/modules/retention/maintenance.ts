import "server-only";
import { createLogger } from "@/platform/logger";
import {
  maintainSummaryMonth, summaryMonthsDue, type DueSummaryMonth, type SummaryMonthRefresh, type SummaryMonthState,
} from "./repository";

/**
 * Summary maintenance (Phase 2, task 8; decision 6), run by the scheduled
 * Trigger.dev task. Each due month is refreshed in its own database call,
 * within the 8 s statement timeout: changed months first (late refunds,
 * returns and corrections to final months become adjustments), then every
 * month that can still change (open months rebuilt, months finalised 120 days
 * after they end, cohorts until 485 days). A shop whose refresh fails is
 * skipped for the rest of the run and reported. Months left when the time
 * budget runs out stay due for the next run.
 */
const log = createLogger({ module: "summary-maintenance" });

export interface MaintenanceReport {
  due: number;
  refreshed: number;
  /** Months of a shop that failed earlier in the run. */
  skipped: number;
  /** Months left for the next run when the time budget ran out. */
  deferred: number;
  states: Partial<Record<SummaryMonthState, number>>;
  adjustments: { product: number; store: number };
  failures: Array<{ shop: string; month: string; error: string }>;
}

export interface MaintenanceDeps {
  due: (limit: number) => Promise<DueSummaryMonth[]>;
  refresh: (shopKey: number, month: string) => Promise<SummaryMonthRefresh>;
  now: () => number;
}

const live: MaintenanceDeps = { due: summaryMonthsDue, refresh: (shopKey, month) => maintainSummaryMonth(shopKey, month), now: Date.now };

export async function maintainSummaries(options: { budgetMs: number; limit?: number }, deps: MaintenanceDeps = live): Promise<MaintenanceReport> {
  const started = deps.now();
  const due = await deps.due(options.limit ?? 1000);
  const report: MaintenanceReport = {
    due: due.length, refreshed: 0, skipped: 0, deferred: 0, states: {}, adjustments: { product: 0, store: 0 }, failures: [],
  };
  const failedShops = new Set<number>();

  for (const [index, item] of due.entries()) {
    if (deps.now() - started >= options.budgetMs) {
      report.deferred = due.length - index;
      break;
    }
    if (failedShops.has(item.shop_key)) {
      report.skipped += 1;
      continue;
    }
    try {
      const result = await deps.refresh(item.shop_key, item.month);
      report.refreshed += 1;
      report.states[result.state] = (report.states[result.state] ?? 0) + 1;
      report.adjustments.product += result.product_adjustments ?? 0;
      report.adjustments.store += result.store_adjustments ?? 0;
    } catch (error) {
      failedShops.add(item.shop_key);
      report.failures.push({ shop: item.shop_domain, month: item.month, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
      log.warn("Summary month refresh failed", { shop: item.shop_domain, month: item.month }, error);
    }
  }

  log.info("Summary maintenance finished", {
    due: report.due, refreshed: report.refreshed, skipped: report.skipped, deferred: report.deferred,
    productAdjustments: report.adjustments.product, storeAdjustments: report.adjustments.store, failures: report.failures.length,
  });
  return report;
}
