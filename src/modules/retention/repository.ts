import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import { AGGREGATE_CALC_VERSION } from "./policy";

export interface AggregateRefresh {
  product_months: number;
  store_months: number;
  cohort_months: number;
  products_dated: number;
}

/**
 * Rebuilds a shop's monthly product, store and cohort summaries for the
 * months from..to (migration 0030) and widens its products' sale dates.
 * Months already final are left as they are. Phase 2 schedules this after
 * each import and daily over aggregateRefreshRange().
 */
export async function refreshMonthlyAggregates(
  shopKey: number,
  range: { from: string; to: string },
  calcVersion: number = AGGREGATE_CALC_VERSION,
): Promise<AggregateRefresh> {
  const { data, error } = await supabaseAdmin.rpc("refresh_monthly_aggregates", {
    p_shop_key: shopKey, p_from: range.from, p_to: range.to, p_calc_version: calcVersion,
  });
  if (error || !data) throw new Error(`Aggregate refresh failed: ${error?.message ?? "no result"}`);
  return data as AggregateRefresh;
}

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
