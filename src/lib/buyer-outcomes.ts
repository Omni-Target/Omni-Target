import type { StorePostEntryBridgeEvidence } from "./store-data";

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

export type PostEntryBridgeEvidence = StorePostEntryBridgeEvidence;

export interface BuyerOutcomes {
  median_days_to_second_order: number | null;
  repeat_buyers_observed: number;
  identified_buyers: number;
  high_value_entry: Map<number, HighValueEntryEvidence>;
  post_entry_bridge: Map<number, PostEntryBridgeEvidence>;
}

const DAY_MS = 86_400_000;
const SIXTY_DAY_WINDOW_MS = 60 * DAY_MS;
const VALUE_WINDOW_MS = 180 * DAY_MS;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseAmount(order: BuyerOutcomeOrder): number {
  const amount = Number(order.current_subtotal_price ?? order.subtotal_price ?? order.total_price);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** Computes aggregate outcomes and entry-to-second-order product bridges; customer IDs and orders are never returned. */
export function calculateBuyerOutcomes(
  orders: BuyerOutcomeOrder[],
  asOf: string,
  productNames?: Map<number, string>,
): BuyerOutcomes {
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

  // Per-entry-product longitudinal tracking
  const entryStats = new Map<
    number,
    {
      repeatBuyers: number;
      crossCatalogBuyers: number;
      sameSkuBuyers: number;
      intervalsToSecond: number[];
      nextProductCounts: Map<number, number>;
      mature60dCount: number;
      mature60dFirstSpendSum: number;
      mature60dCumulativeSpendSum: number;
    }
  >();

  const getOrInitEntry = (productId: number) => {
    let entry = entryStats.get(productId);
    if (!entry) {
      entry = {
        repeatBuyers: 0,
        crossCatalogBuyers: 0,
        sameSkuBuyers: 0,
        intervalsToSecond: [],
        nextProductCounts: new Map<number, number>(),
        mature60dCount: 0,
        mature60dFirstSpendSum: 0,
        mature60dCumulativeSpendSum: 0,
      };
      entryStats.set(productId, entry);
    }
    return entry;
  };

  for (const customerOrders of byCustomer.values()) {
    customerOrders.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    const firstOrder = customerOrders[0];
    const firstAt = Date.parse(firstOrder.created_at);
    const firstProducts = new Set(
      (firstOrder.line_items || [])
        .map((item) => item.product_id)
        .filter((id) => Number.isFinite(id) && id > 0),
    );
    const firstSpend = parseAmount(firstOrder);

    if (customerOrders.length > 1) {
      const secondOrder = customerOrders[1];
      const secondAt = Date.parse(secondOrder.created_at);
      const daysToSecond = Math.max(0, (secondAt - firstAt) / DAY_MS);
      intervals.push(daysToSecond);

      const secondProducts = new Set(
        (secondOrder.line_items || [])
          .map((item) => item.product_id)
          .filter((id) => Number.isFinite(id) && id > 0),
      );
      const allLaterProducts = new Set(
        customerOrders
          .slice(1)
          .flatMap((o) => o.line_items || [])
          .map((item) => item.product_id)
          .filter((id) => Number.isFinite(id) && id > 0),
      );

      for (const entryId of firstProducts) {
        const stat = getOrInitEntry(entryId);
        stat.repeatBuyers++;
        stat.intervalsToSecond.push(daysToSecond);

        if (allLaterProducts.has(entryId)) {
          stat.sameSkuBuyers++;
        }
        const boughtDifferentProduct = [...allLaterProducts].some((pid) => pid !== entryId);
        if (boughtDifferentProduct) {
          stat.crossCatalogBuyers++;
        }
        for (const nextId of secondProducts) {
          if (nextId === entryId) continue;
          stat.nextProductCounts.set(nextId, (stat.nextProductCounts.get(nextId) || 0) + 1);
        }
      }
    }

    // 60-day mature value expansion tracking
    if (firstAt <= now - SIXTY_DAY_WINDOW_MS && firstSpend > 0) {
      const cumulative60dSpend = customerOrders.reduce((sum, order) => {
        if (Date.parse(order.created_at) > firstAt + SIXTY_DAY_WINDOW_MS) return sum;
        return sum + parseAmount(order);
      }, 0);
      for (const entryId of firstProducts) {
        const stat = getOrInitEntry(entryId);
        stat.mature60dCount++;
        stat.mature60dFirstSpendSum += firstSpend;
        stat.mature60dCumulativeSpendSum += cumulative60dSpend;
      }
    }

    // 180-day mature high-value entry tracking
    if (firstAt > now - VALUE_WINDOW_MS) continue;
    const value = customerOrders.reduce((sum, order) => {
      if (Date.parse(order.created_at) > firstAt + VALUE_WINDOW_MS) return sum;
      return sum + parseAmount(order);
    }, 0);
    mature.push({ products: firstProducts, value });
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

  const postEntryBridge = new Map<number, PostEntryBridgeEvidence>();
  for (const [entryId, stat] of entryStats.entries()) {
    if (stat.repeatBuyers === 0 && stat.mature60dCount < 3) continue;

    // Identify the strongest second-order cross-sell destination (minimum 2 repeat buyers transitioning to it)
    const sortedNext = [...stat.nextProductCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    );
    const topNext = sortedNext[0] && sortedNext[0][1] >= 2 ? sortedNext[0] : undefined;

    const hasMatureSpend = stat.mature60dCount >= 3 && stat.mature60dFirstSpendSum > 0;
    const avgFirstSpend = hasMatureSpend
      ? round2(stat.mature60dFirstSpendSum / stat.mature60dCount)
      : null;
    const avg60dSpend = hasMatureSpend
      ? round2(stat.mature60dCumulativeSpendSum / stat.mature60dCount)
      : null;
    const expansionMultiple =
      avgFirstSpend && avg60dSpend && avgFirstSpend > 0
        ? round2(avg60dSpend / avgFirstSpend)
        : null;

    postEntryBridge.set(entryId, {
      repeat_buyers_from_entry: stat.repeatBuyers,
      cross_catalog_repeat_buyers: stat.crossCatalogBuyers,
      same_sku_repeat_buyers: stat.sameSkuBuyers,
      median_days_to_second_order:
        stat.intervalsToSecond.length >= 3
          ? round2(median(stat.intervalsToSecond)!)
          : null,
      ...(topNext
        ? {
            top_next_product_id: topNext[0],
            ...(productNames?.get(topNext[0])
              ? { top_next_product_name: productNames.get(topNext[0]) }
              : {}),
            top_next_product_buyers: topNext[1],
            top_next_product_share:
              stat.repeatBuyers > 0 ? round2(topNext[1] / stat.repeatBuyers) : null,
          }
        : {}),
      avg_first_order_spend: avgFirstSpend,
      avg_60d_cumulative_spend: avg60dSpend,
      value_expansion_60d_multiple: expansionMultiple,
    });
  }

  return {
    median_days_to_second_order: intervals.length >= 5 ? median(intervals) : null,
    repeat_buyers_observed: intervals.length,
    identified_buyers: byCustomer.size,
    high_value_entry: highValueEntry,
    post_entry_bridge: postEntryBridge,
  };
}
