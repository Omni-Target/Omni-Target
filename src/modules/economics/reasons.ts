/**
 * The reason-code catalogue (Phase 4; architecture/phase-4-economics.md, "Verdicts"). Every verdict, missing
 * input, constraint and evidence note is one of these codes, with a plain-language explanation that the brief
 * renders verbatim. The catalogue is versioned with the calculation.
 */
export type ReasonCategory = "restriction" | "missing" | "economics" | "evidence" | "constraint";

export const REASONS = {
  // Hard restrictions (BLOCKED).
  PRODUCT_NOT_ACTIVE: { category: "restriction", text: "The product is not active in Shopify." },
  GIFT_CARD: { category: "restriction", text: "Gift cards are not advertised as products." },
  ZERO_PRICE: { category: "restriction", text: "The product's price is zero." },
  OUT_OF_STOCK: { category: "restriction", text: "No stock is available at any location that fulfils online orders, and the product stops selling when out of stock." },
  TARGET_MARKET_NOT_SERVICED: { category: "restriction", text: "No active market and shipping zone serves the target country." },
  MERCHANT_EXCLUDED: { category: "restriction", text: "The merchant excluded this product from advertising." },
  // Essential inputs missing or unreliable (INSUFFICIENT DATA).
  SHOP_CURRENCY_UNKNOWN: { category: "missing", text: "The shop's currency is not known yet." },
  PRICE_UNKNOWN: { category: "missing", text: "The product has no variant with a price." },
  UNIT_COST_MISSING: { category: "missing", text: "No unit cost is recorded in Shopify for the product's variants." },
  UNIT_COST_PARTIAL: { category: "missing", text: "Some of the variants that sell have no unit cost in Shopify." },
  UNIT_COST_ZERO: { category: "missing", text: "A variant that sells has a unit cost of zero in Shopify, which is almost always a missing cost." },
  UNIT_COST_CURRENCY_MISMATCH: { category: "missing", text: "A unit cost is recorded in a different currency from the shop's." },
  LANDED_COST_UNCONFIRMED: { category: "missing", text: "Landed costs (freight, duties) are neither entered nor confirmed as included in the unit cost." },
  PAYMENT_FEES_MISSING: { category: "missing", text: "Payment processing fees are not entered." },
  SHIPPING_COST_MISSING: { category: "missing", text: "The cost of shipping an order is not entered." },
  FULFILMENT_COST_MISSING: { category: "missing", text: "Fulfilment costs are not entered or confirmed as none." },
  SELLING_FEES_UNCONFIRMED: { category: "missing", text: "Other selling fees are not entered or confirmed as none." },
  RETURN_COST_MISSING: { category: "missing", text: "Returns happen, but the cost of handling one is not entered." },
  DISCOUNT_RATE_UNKNOWN: { category: "missing", text: "There is no discount history for the product or store, and no expected discount rate is entered." },
  RETURN_RATE_UNVERIFIED: { category: "missing", text: "There is not enough matured refund and return history, and no expected rate is entered." },
  TAX_RATE_UNKNOWN: { category: "missing", text: "Prices include tax, but no order shows how much." },
  // Economics.
  NEGATIVE_CONTRIBUTION_MARGIN: { category: "economics", text: "Each order loses money before any advertising: variable costs exceed net revenue." },
  CPA_ABOVE_BREAK_EVEN: { category: "economics", text: "Measured campaign results show a cost per sale above what each sale can pay for." },
  CPA_ABOVE_TARGET: { category: "economics", text: "Measured cost per sale is above the target, though below break-even." },
  // Evidence notes.
  INSUFFICIENT_CONVERSION_EVIDENCE: { category: "evidence", text: "Advertising has not yet produced enough matured sales to prove an acquisition cost." },
  NO_SALES_HISTORY: { category: "evidence", text: "The product has no sales in the last year." },
  SALES_SAMPLE_SMALL: { category: "evidence", text: "Few orders in the last year, so the product's own rates are uncertain." },
  ATTRIBUTION_IMMATURE: { category: "evidence", text: "Recent conversions may still be arriving; recent days are not judged yet." },
  DISCOUNT_RATE_STORE_PROXY: { category: "evidence", text: "The store-wide discount rate stands in for the product's, which has too little history." },
  DISCOUNT_RATE_MERCHANT_ESTIMATE: { category: "evidence", text: "The discount rate is the merchant's estimate: there is no history." },
  RETURN_RATE_STORE_PROXY: { category: "evidence", text: "The store-wide refund and return rates stand in for the product's, which has too little matured history." },
  RETURN_RATE_MERCHANT_ESTIMATE: { category: "evidence", text: "Refund and return rates are the merchant's estimates: there is no matured history." },
  REFUND_EVIDENCE_INCOMPLETE: { category: "evidence", text: "Some refunds on the product's orders have not been read in full, so its own refund rate is not used." },
  RECOVERY_NOT_ASSUMED: { category: "evidence", text: "Without the product's own refund history, refunded units are assumed not to be restocked." },
  SHIPPING_REVENUE_UNOBSERVED: { category: "evidence", text: "No order shows what customers pay for shipping this product, so none is counted." },
  SHIPPING_REVENUE_ALLOCATED: { category: "evidence", text: "Customer-paid shipping is allocated from orders that also held other products." },
  TAX_ALLOCATED: { category: "evidence", text: "Tax is allocated to the product from each order's total tax by line value." },
  TAX_UNOBSERVED: { category: "evidence", text: "No order shows the tax charged on top of the price, so payment fees on tax are not counted." },
  TAX_TREATMENT_ASSUMED_INCLUDED: { category: "evidence", text: "Whether prices include tax is not known, so tax is assumed to be included and removed from revenue." },
  UNPAID_ORDERS_ADJUSTED: { category: "evidence", text: "Some orders are never paid; acquisition costs are measured per order placed, so break-even is reduced accordingly." },
  UNPAID_SHARE_UNOBSERVED: { category: "evidence", text: "There is no order history showing how many orders go unpaid; all are assumed paid." },
  SINGLE_UNIT_ASSUMED: { category: "evidence", text: "Without sales, an order is assumed to hold one unit." },
  COST_SETTINGS_STALE: { category: "evidence", text: "Some cost inputs were entered long ago and may be out of date." },
  COST_SETTINGS_CURRENCY_CHANGED: { category: "evidence", text: "Some cost inputs were entered in a previous shop currency and are not used." },
  // Constraints.
  INVENTORY_LIMITED: { category: "constraint", text: "Stock available for advertising limits how many sales can be fulfilled." },
  INVENTORY_UNTRACKED: { category: "constraint", text: "Shopify does not track this product's stock, so no stock limit can be checked." },
  INVENTORY_OVERSELL_ALLOWED: { category: "constraint", text: "The product keeps selling when out of stock; only stock on hand is counted." },
  INVENTORY_STALE: { category: "constraint", text: "Stock levels have not been confirmed recently." },
  MERCHANT_LIMIT_BINDING: { category: "constraint", text: "The merchant's own spending limit sets the budget." },
  MERCHANT_AUTHORITY_MISSING: { category: "constraint", text: "No spending limit has been authorised by the merchant, so no amount is recommended." },
  PORTFOLIO_LIMIT_REACHED: { category: "constraint", text: "The merchant's total advertising limit is already allocated to other products." },
  POLICY_LIMIT_BINDING: { category: "constraint", text: "The test is sized by policy to learn, not to scale." },
  BUDGET_BELOW_MINIMUM_TEST: { category: "constraint", text: "The amount available is too small to learn anything from a test." },
} as const satisfies Record<string, { category: ReasonCategory; text: string }>;

export type ReasonCode = keyof typeof REASONS;
export const isReason = (code: string): code is ReasonCode => code in REASONS;
