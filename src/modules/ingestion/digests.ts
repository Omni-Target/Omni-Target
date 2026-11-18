import { subjectDigest } from "@/modules/compliance/suppression";
import type { CustomerRow, OrderRow } from "./mappers";

/**
 * Suppression digests for rows on their way into the mirror (decision 5).
 * The write functions compare them with redaction_suppressions: a suppressed
 * customer is not stored, and a suppressed customer's or order's order loses
 * its customer reference and destination. Plain hex: the SQL decodes it.
 */
export type OrderWithDigests = OrderRow & { customer_digest: string | null; order_digest: string };
export type CustomerWithDigest = CustomerRow & { digest: string };

export function withOrderDigests(orders: OrderRow[], key: Buffer, shopifyShopId: number): OrderWithDigests[] {
  return orders.map((order) => ({
    ...order,
    customer_digest: order.customer_shopify_id === null ? null : subjectDigest(key, shopifyShopId, "customer", order.customer_shopify_id).toString("hex"),
    order_digest: subjectDigest(key, shopifyShopId, "order", order.shopify_id).toString("hex"),
  }));
}

export function withCustomerDigests(customers: CustomerRow[], key: Buffer, shopifyShopId: number): CustomerWithDigest[] {
  return customers.map((customer) => ({ ...customer, digest: subjectDigest(key, shopifyShopId, "customer", customer.shopify_id).toString("hex") }));
}
