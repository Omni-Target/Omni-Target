/**
 * Bulk queries per data domain (Phase 2, task 4), checked against the Admin
 * API 2026-07 schema. Each one:
 * - passes assertLevel1Query: no names, emails, phones, address lines, zip;
 *   a shipping address gives city, province and country only;
 * - stays within Shopify's bulk limits: at most 5 connections, nested at most
 *   2 deep (queries.test.ts checks both);
 * - is filtered by Shopify's search syntax, for history windows and for the
 *   daily reconcile (updated_at at or after a watermark).
 */

/** A Shopify search filter, quoted for embedding. Dates are ISO timestamps. */
export function searchFilter(parts: Array<[field: "processed_at" | "updated_at" | "created_at", op: ">=" | "<", at: Date]>): string {
  return parts.map(([field, op, at]) => `${field}:${op}'${at.toISOString()}'`).join(" ");
}

const withQuery = (connection: string, filter?: string) => (filter ? `${connection}(query: ${JSON.stringify(filter)})` : connection);

export function catalogQuery(filter?: string): string {
  return `{
  ${withQuery("products", filter)} {
    edges { node {
      id title handle status productType vendor tags isGiftCard publishedAt createdAt updatedAt
      category { fullName }
      description(truncateAt: 600)
      variants { edges { node {
        id title sku position price compareAtPrice taxable inventoryPolicy inventoryQuantity createdAt updatedAt
        selectedOptions { name value }
        inventoryItem { id tracked requiresShipping countryCodeOfOrigin unitCost { amount currencyCode } measurement { weight { value unit } } }
      } } }
      metafields { edges { node { id namespace key type value updatedAt } } }
    } }
  }
}`;
}

export function inventoryQuery(filter?: string): string {
  return `{
  ${withQuery("inventoryItems", filter)} {
    edges { node {
      id
      inventoryLevels { edges { node { id updatedAt location { id } quantities(names: ["available", "on_hand"]) { name quantity } } } }
    } }
  }
}`;
}

/** Not a bulk query: shops have few locations. */
export const LOCATIONS_QUERY = `query Locations($after: String) {
  locations(first: 250, after: $after, includeInactive: true) {
    nodes { id name isActive fulfillsOnlineOrders isFulfillmentService address { countryCode provinceCode } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function ordersQuery(filter?: string): string {
  return `{
  ${withQuery("orders", filter)} {
    edges { node {
      id name createdAt processedAt cancelledAt updatedAt test sourceName
      displayFinancialStatus displayFulfillmentStatus currencyCode presentmentCurrencyCode
      subtotalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      customer { id }
      shippingAddress { city provinceCode countryCodeV2 }
      lineItems { edges { node {
        id title sku quantity currentQuantity product { id } variant { id }
        originalUnitPriceSet { shopMoney { amount } } totalDiscountSet { shopMoney { amount } }
      } } }
      refunds { id createdAt totalRefundedSet { shopMoney { amount currencyCode } } }
    } }
  }
}`;
}

export function customersQuery(filter?: string): string {
  return `{
  ${withQuery("customers", filter)} {
    edges { node { id createdAt updatedAt numberOfOrders amountSpent { amount currencyCode } } }
  }
}`;
}

export function returnsQuery(filter?: string): string {
  return `{
  ${withQuery("orders", filter)} {
    edges { node {
      id
      returns { edges { node {
        id name status createdAt closedAt totalQuantity
        returnLineItems { edges { node {
          id quantity returnReasonDefinition { handle }
          ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } }
        } } }
      } } }
    } }
  }
}`;
}

export const BULK_QUERIES = {
  catalog: catalogQuery,
  inventory: inventoryQuery,
  orders: ordersQuery,
  customers: customersQuery,
  returns: returnsQuery,
} as const;
export type BulkDomain = keyof typeof BULK_QUERIES;
