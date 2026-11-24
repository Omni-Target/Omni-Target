/**
 * FROZEN REFERENCE: the Phase S0.6 interim budget plan as it stands on
 * `staging` at de99514 (src/lib/budget-plan.ts:76-102 and
 * brief-html-template.ts:1076-1083). Phase 4 replaces it; this copy keeps the
 * before-and-after comparison runnable after it is gone.
 *
 * The interim makes no recommendation: the merchant's own maximum is split
 * evenly over the test, rounded down, whatever the product's economics.
 *
 * The app never imports this file (src/platform/boundaries.test.ts).
 */
export const INTERIM_SOURCE = "staging@de99514" as const;

export interface InterimPlan {
  basis: "merchant_cap" | "not_set";
  maxTotalBudget: number | null;
  durationDays: 7 | 14 | 30;
  dailyCap: number | null;
  /** PDF: price less recorded unit cost, "a break-even ceiling on product cost alone"; none without a cost. */
  costCeilingPerSale: number | null;
}

export function interimBudgetPlan(input: {
  maxTotalBudget: number | null;
  durationDays?: 7 | 14 | 30;
  zeroDecimalCurrency?: boolean;
  priceLessUnitCost?: number | null;
}): InterimPlan {
  const duration = input.durationDays ?? 14;
  const total = input.maxTotalBudget !== null && input.maxTotalBudget > 0 ? Math.round(input.maxTotalBudget * 100) / 100 : null;
  let dailyCap: number | null = null;
  if (total !== null) {
    const cents = Math.round(total * 100);
    dailyCap = input.zeroDecimalCurrency ? Math.floor(cents / (duration * 100)) : Math.floor(cents / duration) / 100;
  }
  const ceiling = input.priceLessUnitCost ?? null;
  return {
    basis: total === null ? "not_set" : "merchant_cap",
    maxTotalBudget: total,
    durationDays: duration,
    dailyCap,
    costCeilingPerSale: ceiling !== null && ceiling > 0 ? ceiling : null,
  };
}
