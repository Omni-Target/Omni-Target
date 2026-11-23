/**
 * Whether a variant can be sold now (Phase 3, task 3; Phase 0 finding ING-09).
 *
 * Shopify sells a variant whose inventory it does not track (REST
 * `inventory_management: null`), and one whose policy is to keep selling when
 * out of stock (`inventory_policy: "continue"`), whatever its quantity. Only a
 * tracked variant that stops selling depends on its available quantity. When
 * tracking is not known (undefined), the quantity decides, as before.
 */
export interface SellableVariant {
  inventory_quantity: number;
  inventory_management?: string | null;
  inventory_policy?: string | null;
}

export function variantSellable(variant: SellableVariant): boolean {
  if (variant.inventory_management === null) return true;
  if (variant.inventory_policy === "continue") return true;
  return variant.inventory_quantity > 0;
}
