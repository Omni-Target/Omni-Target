import { buildProductDecisions } from "./gateway-decision";

interface ValidationOrder {
  id: number;
  created_at: string;
  customer?: { id: number };
  line_items?: Array<{ product_id: number }>;
}

export interface GatewaySignalValidation {
  candidate_product_id: number;
  training_first_buyers: number;
  training_first_buyers_with_product: number;
  later_first_buyers: number;
  later_first_buyers_with_product: number;
  training_share: number;
  later_share: number;
  limitation: "historical_first_order_signal_only";
}

/** Temporal holdout of the historical first-order signal, not a Meta performance test. */
export function validateGatewaySignal(
  orders: ValidationOrder[],
  productIds: number[],
  asOf: string,
): GatewaySignalValidation | null {
  const byCustomer = new Map<number, ValidationOrder[]>();
  const seen = new Set<number>();
  const now = Date.parse(asOf);
  for (const order of orders) {
    const customerId = order.customer?.id;
    const at = Date.parse(order.created_at);
    if (!customerId || seen.has(order.id) || !Number.isFinite(at) || at > now) continue;
    seen.add(order.id);
    const group = byCustomer.get(customerId) || [];
    group.push(order);
    byCustomer.set(customerId, group);
  }
  const firstOrders = [...byCustomer.values()].map((group) => {
    group.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    return group[0];
  }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  if (firstOrders.length < 40) return null;

  const cutoffIndex = Math.floor(firstOrders.length * 0.7);
  const cutoff = Date.parse(firstOrders[cutoffIndex - 1].created_at);
  const trainingFirst = firstOrders.filter((order) => Date.parse(order.created_at) <= cutoff);
  const laterFirst = firstOrders.filter((order) => Date.parse(order.created_at) > cutoff);
  if (trainingFirst.length < 25 || laterFirst.length < 10) return null;
  const trainingOrders = orders.filter((order) => {
    const at = Date.parse(order.created_at);
    return Number.isFinite(at) && at <= cutoff;
  });
  const decisions = buildProductDecisions(
    trainingOrders,
    productIds.map((id) => ({ id, variants: [{ inventory_quantity: 1 }], unit_cost_coverage: "complete" })),
    { asOf: new Date(cutoff).toISOString(), ingestionComplete: true },
  );
  const candidate = [...decisions.entries()]
    .filter(([, decision]) => decision.role === "Gateway")
    .sort((a, b) => b[1].first_order_count - a[1].first_order_count)[0];
  if (!candidate) return null;
  const productId = candidate[0];
  const contains = (order: ValidationOrder) =>
    order.line_items?.some((line) => line.product_id === productId) ?? false;
  const trainingWithProduct = trainingFirst.filter(contains).length;
  const laterWithProduct = laterFirst.filter(contains).length;
  return {
    candidate_product_id: productId,
    training_first_buyers: trainingFirst.length,
    training_first_buyers_with_product: trainingWithProduct,
    later_first_buyers: laterFirst.length,
    later_first_buyers_with_product: laterWithProduct,
    training_share: trainingWithProduct / trainingFirst.length,
    later_share: laterWithProduct / laterFirst.length,
    limitation: "historical_first_order_signal_only",
  };
}
