import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import { AGGREGATE_CALC_VERSION } from "./policy";

/**
 * What one month's refresh did (migration 0036): an open month rebuilt, a month
 * finalised 120 days after it ended, a final month's late changes recorded as
 * adjustments (or none found), a final month before the window or without
 * detail left as it is, or, for the maintenance task, a shop no longer ready.
 */
export type SummaryMonthState = "open" | "finalised" | "empty" | "adjusted" | "unchanged" | "frozen" | "not_ready";

export type SummaryMonthRefresh = {
  month: string;
  state: SummaryMonthState;
  product_months?: number;
  store_months?: number;
  cohort_months?: number;
  products_dated?: number;
  product_adjustments?: number;
  store_adjustments?: number;
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error || data === null || data === undefined) throw new Error(`${fn} failed: ${error?.message ?? "no result"}`);
  return data as T;
}

/** One month of one shop's summaries, in one database call (an import refreshing its window). */
export const refreshSummaryMonth = (shopKey: number, month: string, calcVersion: number = AGGREGATE_CALC_VERSION) =>
  rpc<SummaryMonthRefresh>("refresh_summary_month", { p_shop_key: shopKey, p_month: month, p_calc_version: calcVersion });

/** The scheduled maintenance's refresh: as refreshSummaryMonth, after re-checking the shop is ready. */
export const maintainSummaryMonth = (shopKey: number, month: string, calcVersion: number = AGGREGATE_CALC_VERSION) =>
  rpc<SummaryMonthRefresh>("maintain_summary_month", { p_shop_key: shopKey, p_month: month, p_calc_version: calcVersion });

export interface DueSummaryMonth {
  shop_key: number;
  shop_domain: string;
  month: string;
  reason: "changed" | "open";
}

/** Months the maintenance task refreshes: changed months first, then those that can still change. */
export const summaryMonthsDue = (limit = 1000) => rpc<DueSummaryMonth[]>("summary_months_due", { p_limit: limit });

export interface RetentionStatus {
  retention_months: number;
  cutoff: string;
  orders_beyond: number;
  line_items_beyond: number;
  customers_beyond: number;
  months_beyond: number;
  months_beyond_unsummarised: number;
  pruning: "not_authorised";
}

/** What the 24-month window would cover for a shop. Read-only: nothing is pruned. */
export async function retentionStatus(shopKey: number): Promise<RetentionStatus> {
  const { data, error } = await supabaseAdmin.rpc("retention_status", { p_shop_key: shopKey });
  if (error || !data) throw new Error(`Retention status unavailable: ${error?.message ?? "no result"}`);
  return data as RetentionStatus;
}
