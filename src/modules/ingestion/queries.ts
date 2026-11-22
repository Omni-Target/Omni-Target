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

// Field selections shared by the bulk queries and the incremental sync's by-ID queries (task 10), so both read
// exactly the same Level 1 fields.
const PRODUCT_FIELDS = `id title handle status productType vendor tags isGiftCard publishedAt createdAt updatedAt
      category { fullName }
      description(truncateAt: 600)`;
const VARIANT_FIELDS = `id title sku position price compareAtPrice taxable inventoryPolicy inventoryQuantity createdAt updatedAt
        selectedOptions { name value }
        inventoryItem { id tracked requiresShipping countryCodeOfOrigin unitCost { amount currencyCode } measurement { weight { value unit } } }`;
const METAFIELD_FIELDS = "id namespace key type value updatedAt";
const INVENTORY_LEVEL_FIELDS = `id updatedAt location { id } quantities(names: ["available", "on_hand"]) { name quantity }`;
const ORDER_FIELDS = `id name createdAt processedAt cancelledAt updatedAt test sourceName
      displayFinancialStatus displayFulfillmentStatus currencyCode presentmentCurrencyCode
      subtotalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      customer { id }
      shippingAddress { city provinceCode countryCodeV2 }`;
const LINE_ITEM_FIELDS = `id title sku quantity currentQuantity product { id } variant { id }
        originalUnitPriceSet { shopMoney { amount } } totalDiscountSet { shopMoney { amount } }`;
const REFUND_FIELDS = "refunds { id createdAt processedAt totalRefundedSet { shopMoney { amount currencyCode } } }";
const CUSTOMER_FIELDS = "id createdAt updatedAt numberOfOrders amountSpent { amount currencyCode }";
const RETURN_FIELDS = "id name status createdAt closedAt totalQuantity";
const RETURN_LINE_ITEM_FIELDS = `id quantity returnReasonDefinition { handle }
          ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } }`;

export function catalogQuery(filter?: string): string {
  return `{
  ${withQuery("products", filter)} {
    edges { node {
      ${PRODUCT_FIELDS}
      variants { edges { node {
        ${VARIANT_FIELDS}
      } } }
      metafields { edges { node { ${METAFIELD_FIELDS} } } }
    } }
  }
}`;
}

export function inventoryQuery(filter?: string): string {
  return `{
  ${withQuery("inventoryItems", filter)} {
    edges { node {
      id
      inventoryLevels { edges { node { ${INVENTORY_LEVEL_FIELDS} } } }
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
      ${ORDER_FIELDS}
      lineItems { edges { node {
        ${LINE_ITEM_FIELDS}
      } } }
      ${REFUND_FIELDS}
    } }
  }
}`;
}

export function customersQuery(filter?: string): string {
  return `{
  ${withQuery("customers", filter)} {
    edges { node { ${CUSTOMER_FIELDS} } }
  }
}`;
}

export function returnsQuery(filter?: string): string {
  return `{
  ${withQuery("orders", filter)} {
    edges { node {
      id
      returns { edges { node {
        ${RETURN_FIELDS}
        returnLineItems { edges { node {
          ${RETURN_LINE_ITEM_FIELDS}
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

/**
 * By-ID queries of the incremental sync (task 10): one resource's current state, with the bulk queries' fields.
 * Each child connection is paged ($after, pageInfo) and bounded so a query stays well under Shopify's
 * 1,000-point limit (an order with 100 lines costs about 620).
 */
const page = "pageInfo { hasNextPage endCursor }";
export const ORDER_BY_ID = `query OrderById($id: ID!, $after: String) {
  node(id: $id) { ... on Order {
    ${ORDER_FIELDS}
    ${REFUND_FIELDS}
    lineItems(first: 100, after: $after) { ${page} edges { node { ${LINE_ITEM_FIELDS} } } }
  } }
}`;
export const PRODUCT_BY_ID = `query ProductById($id: ID!) {
  node(id: $id) { ... on Product {
    ${PRODUCT_FIELDS}
    variants(first: 50) { ${page} edges { node { ${VARIANT_FIELDS} } } }
    metafields(first: 50) { ${page} edges { node { ${METAFIELD_FIELDS} } } }
  } }
}`;
export const PRODUCT_VARIANTS_PAGE = `query ProductVariants($id: ID!, $after: String) {
  node(id: $id) { ... on Product { id variants(first: 50, after: $after) { ${page} edges { node { ${VARIANT_FIELDS} } } } } }
}`;
export const PRODUCT_METAFIELDS_PAGE = `query ProductMetafields($id: ID!, $after: String) {
  node(id: $id) { ... on Product { id metafields(first: 50, after: $after) { ${page} edges { node { ${METAFIELD_FIELDS} } } } } }
}`;
export const CUSTOMERS_BY_ID = `query CustomersById($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Customer { ${CUSTOMER_FIELDS} } }
}`;
export const INVENTORY_ITEM_BY_ID = `query InventoryItemById($id: ID!, $after: String) {
  node(id: $id) { ... on InventoryItem { id inventoryLevels(first: 50, after: $after) { ${page} edges { node { ${INVENTORY_LEVEL_FIELDS} } } } } }
}`;
export const RETURN_BY_ID = `query ReturnById($id: ID!, $after: String) {
  node(id: $id) { ... on Return {
    ${RETURN_FIELDS}
    order { id }
    returnLineItems(first: 100, after: $after) { ${page} edges { node { ${RETURN_LINE_ITEM_FIELDS} } } }
  } }
}`;

/** Resources updated at or after a time, oldest change first (the daily reconcile, task 10). */
export function updatedSinceQuery(connection: "orders" | "products" | "customers"): string {
  return `query UpdatedSince($query: String!, $after: String) {
  ${connection}(first: 250, after: $after, query: $query, sortKey: UPDATED_AT) { ${page} nodes { id updatedAt } }
}`;
}

