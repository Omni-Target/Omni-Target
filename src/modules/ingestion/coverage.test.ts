import { describe, expect, it } from "vitest";
import { classifyField, orderCoverage } from "./coverage";
import type { JsonlUnit } from "./jsonl";

const money = (amount: string) => ({ shopMoney: { amount } });
const unit = (root: Record<string, unknown>, children: Record<string, unknown>[] = []): JsonlUnit => ({ root, children, firstLine: 1, lastLine: 1 });

describe("order field coverage", () => {
  it("counts present fields and checks that referenced customers, products and variants exist", () => {
    const coverage = orderCoverage([
      unit({ id: "gid://shopify/Order/1", customer: { id: "gid://shopify/Customer/7" }, shippingAddress: { city: "Leeds", countryCodeV2: "GB" },
        totalDiscountsSet: money("5.00"), refunds: [{ id: "gid://shopify/Refund/9" }] }, [
        { id: "gid://shopify/LineItem/11", product: { id: "gid://shopify/Product/3" }, variant: { id: "gid://shopify/ProductVariant/4" },
          totalDiscountSet: money("5.00"), quantity: 2, currentQuantity: 1 },
        { id: "gid://shopify/LineItem/12", product: { id: "gid://shopify/Product/99" }, variant: null, totalDiscountSet: money("0"), quantity: 1, currentQuantity: 1 },
      ]),
      unit({ id: "gid://shopify/Order/2", customer: null, shippingAddress: null, totalDiscountsSet: money("0"), test: true, cancelledAt: "2026-01-01" }),
    ], { customers: new Set(["gid://shopify/Customer/7"]), products: new Set(["gid://shopify/Product/3"]), variants: new Set(["gid://shopify/ProductVariant/4"]) });
    expect(coverage).toMatchObject({
      orders: 2, withCustomer: 1, customerKnown: 1, withShippingAddress: 1, withCity: 1, withProvince: 0, withCountry: 1,
      withOrderDiscount: 1, withRefunds: 1, refunds: 1, cancelled: 1, test: 1, lineItems: 2, lineItemsWithProduct: 2, lineItemsProductKnown: 1,
      lineItemsWithVariant: 1, lineItemsVariantKnown: 1, lineItemsDiscounted: 1, lineItemsRefunded: 1, ordersWhoseLineDiscountsExceedTotal: 0,
    });
  });

  it("tells a withheld field from an empty one and from one never seen", () => {
    expect(classifyField({ records: 10, present: 0, denied: true })).toBe("withheld");
    expect(classifyField({ records: 10, present: 4, denied: false })).toBe("present");
    expect(classifyField({ records: 10, present: 0, denied: false })).toBe("empty");
    expect(classifyField({ records: 0, present: 0, denied: false })).toBe("unseen");
  });
});
