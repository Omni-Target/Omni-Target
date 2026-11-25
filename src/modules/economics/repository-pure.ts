import type { EconomicsPolicySettings } from "./policy";

/** Refund maturity (policy version 2): the store's own 90th-percentile refund lag, within the policy's bounds, once
 *  there are enough refunds to measure it; otherwise the policy's default. */
export function refundMaturityDays(settings: EconomicsPolicySettings, lag: { refunds: number; p90_days: number | null } | null): number {
  if (settings.refund_lag_min_refunds === undefined || !lag || lag.p90_days === null || Number(lag.refunds) < settings.refund_lag_min_refunds) {
    return settings.return_maturity_days;
  }
  return Math.min(settings.refund_maturity_max_days as number, Math.max(settings.refund_maturity_min_days as number, Math.ceil(Number(lag.p90_days))));
}
