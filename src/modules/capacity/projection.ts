/**
 * Import storage projection (Phase 2, task 5). Pure.
 *
 * Projects from the shop's own record counts, each multiplied by its measured
 * row cost on the optimised schema (migration 0029; very large fixture of
 * 2026-11-18, indexes included). Unlike the task 10 per-product and per-order
 * averages, a shop with one variant and few metafields per product is not
 * charged for three of each.
 *
 * - Orders inside the 24-month window are stored in detail.
 * - Orders beyond it add only monthly summary rows (decision 3).
 * - Counts Shopify cannot give cheaply (metafields per product, inventory
 *   levels per variant) come from a sample of the shop's records, falling
 *   back to the fixture's ratios.
 */
import { GROWTH_HEADROOM } from "./policy";

/** Bytes per row, indexes included (fixtures-2026-11-18.json; summaries from retention-summaries-2026-11-18.json). */
export const ROW_BYTES = {
  product: 719,
  variant: 327,
  metafield: 315,
  inventoryLevel: 138,
  customer: 184,
  order: 299,
  lineItem: 236,
  refund: 136,
  return: 181,
  returnLineItem: 147,
  productMetric: 182,
  productMonth: 180,
  storeOrCohortMonth: 1024,
} as const;
export const SHOP_FIXED_BYTES = 256 * 1024;

/** Fallback ratios (the capacity fixtures), used when the shop has not been sampled. */
export const DEFAULT_RATIOS = {
  metafieldsPerProduct: 3,
  inventoryLevelsPerVariant: 2,
  lineItemsPerOrder: 2,
  refundsPerOrder: 0.03,
  returnsPerOrder: 0.02,
  returnLinesPerReturn: 1.2,
  metricWindows: 4,
  /** Share of possible product-months that have sales (fixture: 0.43 of line items). */
  productMonthFill: 0.5,
} as const;

export interface ShopCounts {
  products: number;
  variants: number;
  customers: number;
  ordersInWindow: number;
  ordersBeyondWindow: number;
  /** Months of order history the summaries cover (window plus anything older). */
  monthsOfHistory: number;
  /** Sampled ratios, when known. */
  metafieldsPerProduct?: number;
  inventoryLevelsPerVariant?: number;
  lineItemsPerOrder?: number;
}

export interface ImportProjection {
  bytes: number;
  rawBytes: number;
  breakdown: Record<string, number>;
}

const count = (value: number, name: string) => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
};

export function projectImport(counts: ShopCounts): ImportProjection {
  const products = count(counts.products, "products");
  const variants = count(counts.variants, "variants");
  const customers = count(counts.customers, "customers");
  const inWindow = count(counts.ordersInWindow, "ordersInWindow");
  const beyond = count(counts.ordersBeyondWindow, "ordersBeyondWindow");
  const months = count(counts.monthsOfHistory, "monthsOfHistory");
  const linesPerOrder = count(counts.lineItemsPerOrder ?? DEFAULT_RATIOS.lineItemsPerOrder, "lineItemsPerOrder");

  const lineItemsInWindow = inWindow * linesPerOrder;
  const lineItemsAll = (inWindow + beyond) * linesPerOrder;
  const returns = inWindow * DEFAULT_RATIOS.returnsPerOrder;
  const productsWithSales = Math.min(products, lineItemsInWindow);
  const productMonths = Math.min(products * months, lineItemsAll) * DEFAULT_RATIOS.productMonthFill;

  const breakdown: Record<string, number> = {
    products: products * ROW_BYTES.product,
    variants: variants * ROW_BYTES.variant,
    metafields: products * count(counts.metafieldsPerProduct ?? DEFAULT_RATIOS.metafieldsPerProduct, "metafieldsPerProduct") * ROW_BYTES.metafield,
    inventoryLevels: variants * count(counts.inventoryLevelsPerVariant ?? DEFAULT_RATIOS.inventoryLevelsPerVariant, "inventoryLevelsPerVariant") * ROW_BYTES.inventoryLevel,
    customers: customers * ROW_BYTES.customer,
    orders: inWindow * ROW_BYTES.order,
    lineItems: lineItemsInWindow * ROW_BYTES.lineItem,
    refunds: inWindow * DEFAULT_RATIOS.refundsPerOrder * ROW_BYTES.refund,
    returns: returns * ROW_BYTES.return + returns * DEFAULT_RATIOS.returnLinesPerReturn * ROW_BYTES.returnLineItem,
    productMetrics: productsWithSales * DEFAULT_RATIOS.metricWindows * ROW_BYTES.productMetric,
    summaries: productMonths * ROW_BYTES.productMonth + months * 2 * ROW_BYTES.storeOrCohortMonth,
    fixed: SHOP_FIXED_BYTES,
  };
  for (const key of Object.keys(breakdown)) breakdown[key] = Math.ceil(breakdown[key]);
  const rawBytes = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { bytes: Math.ceil(rawBytes * GROWTH_HEADROOM), rawBytes, breakdown };
}

/** Sampled ratios from a few records: metafields per product and inventory levels per variant. */
export function sampledRatios(sample: { products: number; metafields: number; variants: number; inventoryLevels: number }): Pick<ShopCounts, "metafieldsPerProduct" | "inventoryLevelsPerVariant"> {
  return {
    metafieldsPerProduct: sample.products > 0 ? sample.metafields / sample.products : undefined,
    inventoryLevelsPerVariant: sample.variants > 0 ? sample.inventoryLevels / sample.variants : undefined,
  };
}
