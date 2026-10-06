export interface BuyerOutcomeOrder {
  id: number;
  created_at: string;
  total_price: string;
  subtotal_price?: string;
  current_subtotal_price?: string;
  customer?: { id: number };
  line_items?: Array<{ product_id: number }>;
}

export interface HighValueEntryEvidence {
  eligible_first_buyers: number;
  high_value_buyers: number;
  high_value_first_buyers_with_product: number;
  all_first_buyers_with_product: number;
  high_value_share: number;
  baseline_share: number;
}

export interface BuyerOutcomes {
  median_days_to_second_order: number | null;
  repeat_buyers_observed: number;
  identified_buyers: number;
  high_value_entry: Map<number, HighValueEntryEvidence>;
}

const DAY_MS = 86_400_000;
const VALUE_WINDOW_MS = 180 * DAY_MS;

function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** Computes aggregate outcomes only; customer IDs and orders are never returned. */
export function calculateBuyerOutcomes(orders: BuyerOutcomeOrder[], asOf: string): BuyerOutcomes {
  const now = Date.parse(asOf);
  const byCustomer = new Map<number, BuyerOutcomeOrder[]>();
  const seenOrders = new Set<number>();
  for (const order of orders) {
    const id = order.customer?.id;
    const at = Date.parse(order.created_at);
    if (!id || seenOrders.has(order.id) || !Number.isFinite(at) || at > now) continue;
    seenOrders.add(order.id);
    const customerOrders = byCustomer.get(id) || [];
    customerOrders.push(order);
    byCustomer.set(id, customerOrders);
  }

  const intervals: number[] = [];
  const mature: Array<{ products: Set<number>; value: number }> = [];
  for (const customerOrders of byCustomer.values()) {
    customerOrders.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    const firstAt = Date.parse(customerOrders[0].created_at);
    if (customerOrders.length > 1) {
      const secondAt = Date.parse(customerOrders[1].created_at);
      intervals.push((secondAt - firstAt) / DAY_MS);
    }
    if (firstAt > now - VALUE_WINDOW_MS) continue;
    const products = new Set((customerOrders[0].line_items || [])
      .map((item) => item.product_id).filter((id) => Number.isFinite(id) && id > 0));
    const value = customerOrders.reduce((sum, order) => {
      if (Date.parse(order.created_at) > firstAt + VALUE_WINDOW_MS) return sum;
      const amount = Number(order.current_subtotal_price ?? order.subtotal_price ?? order.total_price);
      return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
    }, 0);
    mature.push({ products, value });
  }

  const highValueEntry = new Map<number, HighValueEntryEvidence>();
  // A top-decile label on a tiny cohort is more noise than evidence.
  if (mature.length >= 50) {
    const sortedValues = mature.map((buyer) => buyer.value).sort((a, b) => b - a);
    const threshold = sortedValues[Math.ceil(mature.length * 0.1) - 1];
    const highValueBuyers = mature.filter((buyer) => buyer.value >= threshold);
    if (threshold > 0 && highValueBuyers.length >= 5 && highValueBuyers.length <= Math.ceil(mature.length * 0.2)) {
      const allCounts = new Map<number, number>();
      const highCounts = new Map<number, number>();
      for (const buyer of mature) for (const id of buyer.products) {
        allCounts.set(id, (allCounts.get(id) || 0) + 1);
      }
      for (const buyer of highValueBuyers) for (const id of buyer.products) {
        highCounts.set(id, (highCounts.get(id) || 0) + 1);
      }
      for (const [id, count] of highCounts) {
        if (count < 3) continue;
        const allCount = allCounts.get(id) || 0;
        highValueEntry.set(id, {
          eligible_first_buyers: mature.length,
          high_value_buyers: highValueBuyers.length,
          high_value_first_buyers_with_product: count,
          all_first_buyers_with_product: allCount,
          high_value_share: count / highValueBuyers.length,
          baseline_share: allCount / mature.length,
        });
      }
    }
  }

  return {
    median_days_to_second_order: intervals.length >= 5 ? median(intervals) : null,
    repeat_buyers_observed: intervals.length,
    identified_buyers: byCustomer.size,
    high_value_entry: highValueEntry,
  };
}
