/**
 * Field coverage of exported orders (Phase 2): how often each field the
 * importer stores is present, and whether the records it refers to exist.
 * Pure; fed with bulk JSONL units plus the ID sets of the other domains.
 *
 * A bulk file carries no per-field errors, so "empty here" cannot tell a
 * withheld field from an empty one. The ordinary API can: classifyField
 * combines both, where a denial reported by the ordinary API means withheld.
 */
import { gidType } from "./gid";
import type { JsonlUnit } from "./jsonl";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const positive = (set: unknown) => Number(obj(obj(set)?.shopMoney)?.amount ?? 0) > 0;

export interface OrderCoverage {
  orders: number;
  withCustomer: number;
  customerKnown: number;
  withShippingAddress: number;
  withCity: number;
  withProvince: number;
  withCountry: number;
  withOrderDiscount: number;
  withRefunds: number;
  refunds: number;
  cancelled: number;
  test: number;
  lineItems: number;
  lineItemsWithProduct: number;
  lineItemsProductKnown: number;
  lineItemsWithVariant: number;
  lineItemsVariantKnown: number;
  lineItemsDiscounted: number;
  lineItemsRefunded: number;
  ordersWhoseLineDiscountsExceedTotal: number;
}

export function orderCoverage(
  units: Iterable<JsonlUnit>,
  known: { customers: Set<string>; products: Set<string>; variants: Set<string> },
): OrderCoverage {
  const c: OrderCoverage = {
    orders: 0, withCustomer: 0, customerKnown: 0, withShippingAddress: 0, withCity: 0, withProvince: 0, withCountry: 0,
    withOrderDiscount: 0, withRefunds: 0, refunds: 0, cancelled: 0, test: 0, lineItems: 0, lineItemsWithProduct: 0,
    lineItemsProductKnown: 0, lineItemsWithVariant: 0, lineItemsVariantKnown: 0, lineItemsDiscounted: 0, lineItemsRefunded: 0,
    ordersWhoseLineDiscountsExceedTotal: 0,
  };
  for (const unit of units) {
    const order = unit.root;
    c.orders += 1;
    const customerId = obj(order.customer)?.id;
    if (typeof customerId === "string") {
      c.withCustomer += 1;
      if (known.customers.has(customerId)) c.customerKnown += 1;
    }
    const address = obj(order.shippingAddress);
    if (address) c.withShippingAddress += 1;
    if (address?.city) c.withCity += 1;
    if (address?.provinceCode) c.withProvince += 1;
    if (address?.countryCodeV2) c.withCountry += 1;
    if (positive(order.totalDiscountsSet)) c.withOrderDiscount += 1;
    const refunds = Array.isArray(order.refunds) ? order.refunds : [];
    if (refunds.length) c.withRefunds += 1;
    c.refunds += refunds.length;
    if (order.cancelledAt) c.cancelled += 1;
    if (order.test === true) c.test += 1;

    let lineDiscounts = 0;
    for (const line of unit.children) {
      if (gidType(line.id) !== "LineItem") continue;
      c.lineItems += 1;
      const productId = obj(line.product)?.id;
      const variantId = obj(line.variant)?.id;
      if (typeof productId === "string") {
        c.lineItemsWithProduct += 1;
        if (known.products.has(productId)) c.lineItemsProductKnown += 1;
      }
      if (typeof variantId === "string") {
        c.lineItemsWithVariant += 1;
        if (known.variants.has(variantId)) c.lineItemsVariantKnown += 1;
      }
      if (positive(line.totalDiscountSet)) c.lineItemsDiscounted += 1;
      lineDiscounts += Number(obj(obj(line.totalDiscountSet)?.shopMoney)?.amount ?? 0);
      if (typeof line.quantity === "number" && typeof line.currentQuantity === "number" && line.currentQuantity < line.quantity) c.lineItemsRefunded += 1;
    }
    if (lineDiscounts > Number(obj(obj(order.totalDiscountsSet)?.shopMoney)?.amount ?? 0) + 0.005) c.ordersWhoseLineDiscountsExceedTotal += 1;
  }
  return c;
}

export type FieldAvailability = "present" | "empty" | "withheld" | "unseen";

/**
 * A field's state across both sources: withheld when the ordinary API denied
 * it; present when any record had a value; empty when records exist and none
 * had one without a denial; unseen when there were no records to look at.
 */
export function classifyField({ records, present, denied }: { records: number; present: number; denied: boolean }): FieldAvailability {
  if (denied) return "withheld";
  if (present > 0) return "present";
  return records > 0 ? "empty" : "unseen";
}
