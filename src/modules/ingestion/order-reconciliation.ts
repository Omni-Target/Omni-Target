/**
 * Order reconciliation (Phase 3, task 1): accounts for every order Shopify
 * reports against what the mirror holds, without assuming a gap is a failed
 * import. Pure; the live check (order-reconciliation.live.test.ts) feeds it.
 *
 * - Orders processed inside the retained window are compared one by one with
 *   the mirror's detailed rows, status included.
 * - Every month (inside and before the window) is compared with the effective
 *   monthly summary (summary + adjustments), which counts orders that are
 *   neither test nor cancelled. Months are UTC calendar months, as stored.
 */
export interface OrderFact {
  id: number;
  processedAt: string;
  cancelled: boolean;
  test: boolean;
  /** Shopify's display financial status, lower-case; null when Shopify reports none. */
  financialStatus: string | null;
}

export interface OrderReconciliation {
  windowStart: string;
  shopify: { total: number; inWindow: number; beforeWindow: number; test: number; cancelled: number; counted: number };
  mirror: { detailed: number };
  /** In-window orders by financial status ("none" when Shopify reports no status). */
  byStatus: Array<{ status: string; shopify: number; mirror: number }>;
  missingInMirror: number[];
  extraInMirror: number[];
  statusMismatches: Array<{ id: number; shopify: string; mirror: string }>;
  months: Array<{ month: string; shopifyCounted: number; effectiveSummary: number | null }>;
  monthMismatches: string[];
  ok: boolean;
}

const monthOf = (iso: string) => `${new Date(iso).toISOString().slice(0, 7)}-01`;
const statusKey = (fact: OrderFact) => fact.financialStatus ?? "none";
const describe = (fact: OrderFact) => `${statusKey(fact)}${fact.cancelled ? "/cancelled" : ""}${fact.test ? "/test" : ""}`;

export function reconcileOrders(input: {
  windowStart: string;
  shopify: OrderFact[];
  mirror: OrderFact[];
  /** Effective orders per month (summary + adjustments), keyed YYYY-MM-01. */
  effectiveMonths: Record<string, number>;
}): OrderReconciliation {
  const start = Date.parse(input.windowStart);
  const inWindow = input.shopify.filter((o) => Date.parse(o.processedAt) >= start);
  const mirrorById = new Map(input.mirror.map((o) => [o.id, o]));
  const shopifyIds = new Set(inWindow.map((o) => o.id));

  const statuses = new Map<string, { shopify: number; mirror: number }>();
  const bump = (key: string, side: "shopify" | "mirror") => {
    const entry = statuses.get(key) ?? { shopify: 0, mirror: 0 };
    entry[side] += 1;
    statuses.set(key, entry);
  };
  inWindow.forEach((o) => bump(statusKey(o), "shopify"));
  input.mirror.forEach((o) => bump(statusKey(o), "mirror"));

  const statusMismatches: OrderReconciliation["statusMismatches"] = [];
  for (const order of inWindow) {
    const stored = mirrorById.get(order.id);
    if (stored && describe(stored) !== describe(order)) statusMismatches.push({ id: order.id, shopify: describe(order), mirror: describe(stored) });
  }

  const counted = new Map<string, number>();
  for (const order of input.shopify) {
    if (order.test || order.cancelled) continue;
    const month = monthOf(order.processedAt);
    counted.set(month, (counted.get(month) ?? 0) + 1);
  }
  const monthKeys = [...new Set([...counted.keys(), ...Object.keys(input.effectiveMonths)])].sort();
  const months = monthKeys.map((month) => ({
    month, shopifyCounted: counted.get(month) ?? 0, effectiveSummary: month in input.effectiveMonths ? input.effectiveMonths[month] : null,
  }));
  const monthMismatches = months.filter((m) => (m.effectiveSummary ?? 0) !== m.shopifyCounted).map((m) => m.month);

  const missingInMirror = inWindow.filter((o) => !mirrorById.has(o.id)).map((o) => o.id);
  const extraInMirror = input.mirror.filter((o) => !shopifyIds.has(o.id)).map((o) => o.id);
  return {
    windowStart: input.windowStart,
    shopify: {
      total: input.shopify.length,
      inWindow: inWindow.length,
      beforeWindow: input.shopify.length - inWindow.length,
      test: input.shopify.filter((o) => o.test).length,
      cancelled: input.shopify.filter((o) => o.cancelled).length,
      counted: input.shopify.filter((o) => !o.test && !o.cancelled).length,
    },
    mirror: { detailed: input.mirror.length },
    byStatus: [...statuses].sort(([a], [b]) => a.localeCompare(b)).map(([status, n]) => ({ status, ...n })),
    missingInMirror,
    extraInMirror,
    statusMismatches,
    months,
    monthMismatches,
    ok: missingInMirror.length === 0 && extraInMirror.length === 0 && statusMismatches.length === 0 && monthMismatches.length === 0,
  };
}
