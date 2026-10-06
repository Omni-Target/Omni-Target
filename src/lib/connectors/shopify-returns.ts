import { fetchWithRetry } from "../http";
import { shopifyAdminGraphqlUrl } from "../shopify-config";
import type { StoreProductReturnEvidence } from "../store-data";

// Initial review policy; calibrate against observed store distributions before changing it.
const MIN_ELIGIBLE_UNITS = 30;
const RETURN_REVIEW_RATE = 0.15;

interface LineItem { quantity: number; product: { legacyResourceId: string } | null }
interface ReturnLineItem {
  processedQuantity: number;
  returnReasonDefinition: { name: string } | null;
  fulfillmentLineItem: { lineItem: LineItem };
}
interface RefundLineItem { quantity: number; lineItem: LineItem }
interface ReturnOrder {
  id: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  lineItems: { nodes: LineItem[]; pageInfo: { hasNextPage: boolean } };
  returns: { nodes: Array<{
    returnLineItems: { nodes: Array<ReturnLineItem | { __typename: string }>; pageInfo: { hasNextPage: boolean } };
  }>; pageInfo: { hasNextPage: boolean } };
  refunds: Array<{ refundLineItems: { nodes: RefundLineItem[]; pageInfo: { hasNextPage: boolean } } }>;
}

const QUERY = `query ReturnEvidence($after: String, $filter: String!) {
  orders(first: 20, after: $after, query: $filter, sortKey: CREATED_AT) {
    nodes {
      id cancelledAt displayFinancialStatus
      lineItems(first: 10) {
        nodes { quantity product { legacyResourceId } }
        pageInfo { hasNextPage }
      }
      returns(first: 2) {
        nodes {
          returnLineItems(first: 5) {
            nodes {
              __typename
              ... on ReturnLineItem {
                processedQuantity
                returnReasonDefinition { name }
                fulfillmentLineItem { lineItem { quantity product { legacyResourceId } } }
              }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
      refunds {
        refundLineItems(first: 10) {
          nodes { quantity lineItem { quantity product { legacyResourceId } } }
          pageInfo { hasNextPage }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

function productId(line: LineItem | null | undefined): string | null {
  const id = line?.product?.legacyResourceId;
  return id && /^\d+$/.test(id) ? id : null;
}

export function calculateReturnEvidence(orders: ReturnOrder[]): Record<string, StoreProductReturnEvidence> {
  const totals = new Map<string, { sold: number; returned: number; refunded: number; reasons: Map<string, number> }>();
  for (const order of orders) {
    if (order.cancelledAt || !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.displayFinancialStatus || "")) continue;
    for (const line of order.lineItems.nodes) {
      const id = productId(line);
      if (!id || line.quantity <= 0) continue;
      const entry = totals.get(id) || { sold: 0, returned: 0, refunded: 0, reasons: new Map() };
      entry.sold += line.quantity;
      totals.set(id, entry);
    }
    for (const returned of order.returns.nodes) for (const line of returned.returnLineItems.nodes) {
      if (!("processedQuantity" in line)) continue;
      const id = productId(line.fulfillmentLineItem?.lineItem);
      const entry = id ? totals.get(id) : undefined;
      if (!entry || line.processedQuantity <= 0) continue;
      entry.returned += line.processedQuantity;
      const reason = line.returnReasonDefinition?.name;
      if (reason) entry.reasons.set(reason, (entry.reasons.get(reason) || 0) + line.processedQuantity);
    }
    for (const refund of order.refunds) for (const line of refund.refundLineItems.nodes) {
      const entry = totals.get(productId(line.lineItem) || "");
      if (entry && line.quantity > 0) entry.refunded += line.quantity;
    }
  }

  return Object.fromEntries([...totals].map(([id, entry]) => {
    if (entry.returned > entry.sold || entry.refunded > entry.sold) {
      throw new Error(`Return evidence exceeds eligible units for product ${id}`);
    }
    const reasons = [...entry.reasons].sort((a, b) => b[1] - a[1]);
    const enoughData = entry.sold >= MIN_ELIGIBLE_UNITS;
    return [id, {
      eligible_units: entry.sold,
      processed_return_units: entry.returned,
      refunded_units: entry.refunded,
      processed_return_rate: enoughData ? entry.returned / entry.sold : null,
      primary_reason: reasons[0]?.[1] >= 3 ? reasons[0][0] : undefined,
      risk: !enoughData ? "insufficient_data" : entry.returned / entry.sold >= RETURN_REVIEW_RATE ? "review" : "observed",
      window_days: 365,
      maturity_days: 60,
    } satisfies StoreProductReturnEvidence];
  }));
}

/** Bounded mature-order cohort. Any pagination gap withholds every derived rate. */
export async function fetchShopifyReturnEvidence(
  shopDomain: string,
  accessToken: string,
  asOf: string,
): Promise<Record<string, StoreProductReturnEvidence>> {
  const now = Date.parse(asOf);
  const from = new Date(now - 365 * 86_400_000).toISOString().slice(0, 10);
  const until = new Date(now - 60 * 86_400_000).toISOString().slice(0, 10);
  const filter = `created_at:>=${from} created_at:<${until}`;
  const orders: ReturnOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let pages = 0;
  const deadline = Date.now() + 22_000;

  while (hasNextPage && pages < 25) {
    if (Date.now() >= deadline) throw new Error("Return evidence sync exceeded its time budget");
    const response = await fetchWithRetry(shopifyAdminGraphqlUrl(shopDomain), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: QUERY, variables: { after: cursor, filter } }),
    }, { timeoutMs: 12_000, retries: 1 });
    if (!response.ok) throw new Error(`Shopify return evidence HTTP ${response.status}`);
    const body = await response.json() as {
      data?: { orders?: { nodes: ReturnOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length || !body.data?.orders) {
      throw new Error(body.errors?.map((error) => error.message).join("; ") || "Return evidence query failed");
    }
    const page = body.data.orders;
    for (const order of page.nodes) {
      if (order.lineItems.pageInfo.hasNextPage || order.returns.pageInfo.hasNextPage ||
          order.returns.nodes.some((item) => item.returnLineItems.pageInfo.hasNextPage) ||
          order.refunds.some((item) => item.refundLineItems.pageInfo.hasNextPage)) {
        throw new Error("Return evidence line-item pagination incomplete");
      }
      orders.push(order);
    }
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
    if (hasNextPage && !cursor) throw new Error("Return evidence order cursor missing");
    pages++;
  }
  if (hasNextPage) throw new Error("Return evidence order pagination limit reached");
  return calculateReturnEvidence(orders);
}
