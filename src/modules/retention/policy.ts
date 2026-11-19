/**
 * Order retention policy (Phase 1, task 11, approved 2026-11-18). Pure.
 *
 * - Detailed orders and line items are kept for 24 months. Monthly product,
 *   store and anonymised cohort summaries (migration 0030) keep the history
 *   beyond that. Pruning is not authorised: it needs a separate approval and
 *   a verified backup and restore.
 * - Without Shopify's read_all_orders scope, a shop's orders are readable for
 *   60 days only. Nothing may assume more.
 *
 * The SQL in migration 0030 uses the same constants; change both together.
 */

export const ORDER_RETENTION_MONTHS = 24;
/** Shopify's read_orders scope reaches this far back; read_all_orders is needed for more. */
export const READ_ORDERS_WINDOW_DAYS = 60;
/** A month's product and store summary is final this long after the month ends (late refunds and returns). */
export const AGGREGATE_FINAL_AFTER_DAYS = 120;
/** A cohort is final once its 365-day repeat window has closed, plus the same 120 days. */
export const COHORT_FINAL_AFTER_DAYS = 365 + AGGREGATE_FINAL_AFTER_DAYS;
export const AGGREGATE_CALC_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `months` calendar months before `at`, in UTC, clamped to the month's last day as Postgres does. */
export function monthsBefore(at: Date, months: number): Date {
  const target = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(at.getUTCDate(), lastDay));
  target.setUTCHours(at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds());
  return target;
}

/** Orders processed before this are outside the detailed retention window (retention_status's cutoff). */
export function retentionCutoff(now: Date = new Date()): Date {
  return monthsBefore(now, ORDER_RETENTION_MONTHS);
}

export type OrderHistoryBasis = "retention_window" | "read_orders_only" | "no_order_access";

export interface OrderHistoryWindow {
  /** The oldest order date to import, or null when orders cannot be read at all. */
  from: Date | null;
  basis: OrderHistoryBasis;
  /** The scope whose absence limits the history, to report to the merchant and to us. */
  missingScope: "read_all_orders" | "read_orders" | null;
}

/**
 * How far back a historical import may read a shop's orders, from the scopes
 * the shop actually granted (currentAppInstallation.accessScopes). The full
 * retention window needs read_all_orders, which Shopify must approve for the
 * app first; without it the window is 60 days and the import is partial.
 */
export function orderHistoryWindow(grantedScopes: readonly string[], now: Date = new Date()): OrderHistoryWindow {
  const granted = new Set(grantedScopes);
  const readsOrders = granted.has("read_orders") || granted.has("write_orders");
  if (!readsOrders) return { from: null, basis: "no_order_access", missingScope: "read_orders" };
  if (granted.has("read_all_orders")) return { from: retentionCutoff(now), basis: "retention_window", missingScope: null };
  return { from: new Date(now.getTime() - READ_ORDERS_WINDOW_DAYS * DAY_MS), basis: "read_orders_only", missingScope: "read_all_orders" };
}

const firstOfMonth = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
const isoDate = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The months whose summaries or cohort can still change, through the current
 * one: the "open" months summary_months_due (migration 0036) lists for the
 * maintenance task. Later changes to earlier, final months reach it as
 * changed months and are recorded as adjustments.
 */
export function aggregateRefreshRange(now: Date = new Date()): { from: string; to: string } {
  return {
    from: isoDate(firstOfMonth(new Date(now.getTime() - COHORT_FINAL_AFTER_DAYS * DAY_MS))),
    to: isoDate(firstOfMonth(now)),
  };
}
