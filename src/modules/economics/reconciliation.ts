import type { ReasonCode } from "./reasons";

/**
 * Attribution reconciliation (Phase 4 closure, policy version 3; architecture/phase-4-economics.md, "Attribution
 * reconciliation"). Before a campaign may be scaled, the purchases Meta reports for it are compared with what Shopify
 * recorded over the same period. Meta cannot legitimately attribute more purchases of the advertised product than the
 * product had orders: a larger count means duplicated events (a pixel and the Conversions API both reporting one order
 * under different event IDs), purchases of other products, or a reporting fault. Statistics cannot correct such a
 * count (the threshold study: with 15% of sales over-reported, break-even products scale about 1 time in 5 even at
 * 97.5%), so scaling waits until the counts reconcile or someone has reviewed them.
 *
 * The comparison is one-sided: Meta reporting FEWER purchases than Shopify recorded is expected (organic sales, lost
 * tracking) and only makes a campaign look worse, never better.
 *
 * Part of calc version econ-1.2.0 (policy version 3, which was approved together with this safeguard). The tolerance
 * comes from reconciliation-study.test.ts.
 */
export const RECONCILIATION = {
  /** Meta may report up to this share more purchases than the ceiling (Meta's modelled conversions)… */
  relativeTolerance: 0.2,
  /** …plus this many purchases, for small counts. */
  absoluteTolerance: 2,
  /**
   * Shopify's order data must reach the last day Meta reported a purchase: its newest order (or sync watermark) must be
   * no earlier than that day's start, less this many hours for time zones (an ad account's day can start up to 14
   * hours before UTC midnight). A quiet shop with no new orders is not stale; Meta purchases Shopify has not seen are.
   */
  ordersLagToleranceHours: 14,
  /** The campaign's most recent results must be at most this many days old. */
  resultsMaxAgeDays: 2,
} as const;

/** What Shopify and Omnitarget recorded over a campaign's period (campaign_reconciliation_evidence, migration 0058). */
export interface ReconciliationEvidence {
  /** The comparison window: from the day before the campaign's first day (time zones), in the shop's time zone, to the check. */
  from: string;
  to: string;
  timezone: string;
  /** Non-test orders containing any of the campaign's products, placed in the window, and those of them paid. */
  placed: number;
  paid: number;
  /** Of those orders, how many Shopify attributes to a visit from Meta (UTM source, visit source or referrer), and how
   *  many carry any customer-journey record at all (orders created through the API carry none). Context only: Meta
   *  also credits purchases that Shopify attributes to other visits, and the reverse. */
  meta_visit_orders?: number;
  journey_known_orders?: number;
  /** Omnitarget Conversions API Purchase events sent for those orders (event ID = the Shopify order ID). */
  capi_sent: number;
  /** Whether the shop sent Omnitarget Conversions API events in the last 90 days. */
  capi_connected: boolean;
  /** When Shopify's orders were last synced. */
  orders_fresh_at: string | null;
  /** The latest manual review of this campaign's counts, if any. */
  review: { through_day: string; outcome: "confirmed" | "corrected"; note: string; reviewed_by: string; reviewed_at: string } | null;
}

export type ReconciliationStatus = "reconciled" | "reviewed" | "over_count" | "stale" | "unavailable";

export interface Reconciliation {
  status: ReconciliationStatus;
  /** Whether scaling may proceed on these counts. */
  scaling_allowed: boolean;
  reason: ReasonCode | null;
  /** Purchases Meta reported for the campaign so far (all result days). */
  meta_purchases: number;
  /** What Meta's count is compared with, and how much above it is tolerated. */
  basis: "paid" | "placed";
  ceiling_source: "shopify_orders" | "capi_events" | null;
  ceiling: number | null;
  allowed: number | null;
  window: { from: string; to: string; timezone: string } | null;
  tolerance: typeof RECONCILIATION;
  explanation: string;
}

/** The count of purchases above which Meta's figure cannot be reconciled with a ceiling. */
export const allowedPurchases = (ceiling: number) =>
  Math.floor(ceiling * (1 + RECONCILIATION.relativeTolerance) + 1e-9) + RECONCILIATION.absoluteTolerance;

export function reconcileAttribution(args: {
  evidence: ReconciliationEvidence | null;
  /** Purchases Meta reported, by result day. */
  results: Array<{ day: string; conversions: number }>;
  /** The last matured result day the scaling decision rests on. */
  lastMaturedDay: string | null;
  /** How the ad platform counts a purchase for these products (from the current economics). */
  purchaseEventBasis: "paid" | "placed" | "unconfirmed" | undefined;
  asOf: string;
}): Reconciliation {
  const meta = args.results.reduce((t, d) => t + d.conversions, 0);
  // Counted when paid: Shopify's paid orders. Placed, or not confirmed: placed orders, which also hold the unpaid
  // cash-on-delivery orders a pixel counts at checkout (the larger ceiling, so no campaign is held back for them).
  const basis = args.purchaseEventBasis === "paid" ? "paid" : "placed";
  const base = { meta_purchases: meta, basis, tolerance: RECONCILIATION } as const;
  const e = args.evidence;
  const review = e?.review ?? null;
  const reviewed = review !== null && args.lastMaturedDay !== null && review.through_day >= args.lastMaturedDay;
  const reviewedNote = reviewed
    ? ` Reviewed by ${review!.reviewed_by} on ${review!.reviewed_at.slice(0, 10)} through ${review!.through_day} (${review!.outcome}): ${review!.note}`
    : "";
  const done = (status: ReconciliationStatus, reason: ReasonCode | null, rest: Partial<Reconciliation>, explanation: string): Reconciliation => {
    const allowed = status === "reconciled" || reviewed;
    return { ...base, ceiling_source: null, ceiling: null, allowed: null, window: null, ...rest,
      status: reviewed && status !== "reconciled" ? "reviewed" : status, scaling_allowed: allowed,
      reason: allowed ? (reviewed && status !== "reconciled" ? "ATTRIBUTION_REVIEWED" : null) : reason,
      explanation: explanation + (reviewed && status !== "reconciled" ? reviewedNote : "") };
  };
  if (!e) {
    return done("unavailable", "ATTRIBUTION_UNRECONCILABLE", {},
      "Shopify's orders for this campaign's products could not be read, so Meta's purchase count cannot be checked.");
  }
  const window = { from: e.from, to: e.to, timezone: e.timezone };
  const asOfMs = Date.parse(args.asOf);
  const lastDay = args.results.map((d) => d.day).sort().at(-1) ?? null;
  const lastPurchaseDay = args.results.filter((d) => d.conversions > 0).map((d) => d.day).sort().at(-1) ?? null;
  const ordersBehind = lastPurchaseDay !== null && (e.orders_fresh_at === null
    || Date.parse(e.orders_fresh_at) < Date.parse(`${lastPurchaseDay}T00:00:00Z`) - RECONCILIATION.ordersLagToleranceHours * 3_600_000);
  const resultsAgeDays = lastDay ? Math.floor((asOfMs - Date.parse(`${lastDay}T00:00:00Z`)) / 86_400_000) - 1 : Infinity;
  if (ordersBehind || resultsAgeDays > RECONCILIATION.resultsMaxAgeDays) {
    const what = ordersBehind
      ? `Meta reports purchases on ${lastPurchaseDay}, but Shopify's newest order on record is from ${e.orders_fresh_at ?? "no date"}: either the order sync is behind or those purchases are not in Shopify`
      : `the campaign's results were last entered for ${lastDay ?? "no day"}`;
    return done("stale", "ATTRIBUTION_EVIDENCE_STALE", { window },
      `Meta's purchase count cannot be checked against current orders: ${what}.`);
  }
  // Omnitarget's Conversions API sends only paid orders, each once (event ID = order ID). When the merchant says Meta
  // counts purchases when paid and Omnitarget sends them, Meta can only have counted the events it received.
  const useCapi = basis === "paid" && e.capi_connected;
  const ceiling = useCapi ? Math.min(e.paid, e.capi_sent) : basis === "paid" ? e.paid : e.placed;
  const ceilingSource = useCapi ? "capi_events" : "shopify_orders";
  const allowed = allowedPurchases(ceiling);
  const described = useCapi
    ? `${e.capi_sent} purchase event(s) Omnitarget sent to Meta for ${e.paid} paid order(s)`
    : `${ceiling} ${basis} Shopify order(s) of the advertised product(s)`;
  const journey = (e.journey_known_orders ?? 0) > 0
    ? ` Shopify attributes ${e.meta_visit_orders ?? 0} of the ${e.placed} order(s) to a visit from Meta (${e.journey_known_orders} with a known customer journey).`
    : "";
  if (meta > allowed) {
    return done("over_count", "ATTRIBUTION_OVER_COUNT", { ceiling_source: ceilingSource, ceiling, allowed, window },
      `Meta reports ${meta} purchase(s) for this campaign, but there were only ${described} from ${e.from.slice(0, 10)} to ${e.to.slice(0, 10)} `
      + `(at most ${allowed} can be reconciled). Likely causes: the same order reported twice (a pixel and the Conversions API under `
      + "different event IDs), purchases of other products, or a reporting fault. Scaling waits until the counts reconcile or are reviewed." + journey);
  }
  return done("reconciled", null, { ceiling_source: ceilingSource, ceiling, allowed, window },
    `Meta reports ${meta} purchase(s); there were ${described} in the same period (up to ${allowed} reconcile).` + journey);
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : Number(v) >= 0 ? Number(v) : 0);
/** The JSON of campaign_reconciliation_evidence (0058) as typed evidence; null for a campaign that is not the shop's. */
export function normaliseReconciliationEvidence(raw: unknown): ReconciliationEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const review = r.review && typeof r.review === "object" ? (r.review as Record<string, unknown>) : null;
  return {
    from: String(r.from), to: String(r.to), timezone: String(r.timezone ?? "UTC"),
    placed: count(r.placed), paid: count(r.paid), meta_visit_orders: count(r.meta_visit_orders), journey_known_orders: count(r.journey_known_orders),
    capi_sent: count(r.capi_sent), capi_connected: r.capi_connected === true,
    orders_fresh_at: typeof r.orders_fresh_at === "string" ? r.orders_fresh_at : null,
    review: review ? { through_day: String(review.through_day).slice(0, 10), outcome: review.outcome === "corrected" ? "corrected" : "confirmed",
      note: String(review.note ?? ""), reviewed_by: String(review.reviewed_by ?? ""), reviewed_at: String(review.reviewed_at) } : null,
  };
}
