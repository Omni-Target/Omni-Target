/**
 * The economics evidence the database aggregates for each product (Phase 4,
 * task 3; product_economics_evidence, migration 0053). Money is in the shop's
 * currency. A null figure was withheld (unread refund lines or returns read
 * before Phase 3's fields), never zero.
 */
export interface EvidenceVariant {
  id: number;
  title: string | null;
  price: number;
  compare_at_price: number | null;
  unit_cost: number | null;
  unit_cost_currency: string | null;
  tracked: boolean | null;
  inventory_policy: string | null;
  requires_shipping: boolean | null;
  available_for_sale: boolean | null;
  /** Units and orders in the sales window (paid orders). */
  units: number;
  orders: number;
  synced_at: string;
}

/** Phase 3's inventory_availability row, without location detail. */
export interface EvidenceInventory {
  variant_id: number;
  state: "untracked" | "unknown" | "in_stock" | "oversell_allowed" | "out_of_stock";
  tracked: boolean | null;
  inventory_policy: string | null;
  quantities_read: boolean;
  online: { locations: number; available: number | null; committed: number | null; incoming: number | null; unavailable: number | null; on_hand: number | null };
  unknown_locations: number;
  collective: boolean;
  fulfilment: string[];
}

export interface EvidenceSales {
  orders_created: number;
  orders: number;
  orders_unpaid: number;
  units: number;
  gross: number;
  discounts: number;
  net: number;
  first_order_at?: string | null;
  last_order_at?: string | null;
  demand_orders: number;
  demand_units: number;
  recent_units: number;
  discount_orders: number;
  discount_gross: number;
  discount_amount: number;
  single_orders: number;
  single_orders_unrefunded: number;
  single_shipping: number;
  multi_orders: number;
  multi_orders_unrefunded: number;
  multi_shipping_allocated: number;
  orders_with_tax: number;
  allocated_tax: number;
}

export interface EvidenceMatured {
  orders: number;
  units: number;
  net: number;
  refunded_amount: number | null;
  refunded_units: number | null;
  returned_restocked_units: number | null;
  cancelled_restocked_units: number | null;
  orders_refunded: number | null;
  returns: number | null;
  returned_units: number | null;
  refunds_unread: number;
  returns_unread: number;
}

export interface ProductEvidence {
  product_id: number;
  product: {
    title: string | null; status: string | null; is_gift_card: boolean | null; collective: boolean; online_store_url: string | null;
    published_at: string | null; requires_selling_plan: boolean | null; fields_version: number | null; created_at: string | null; synced_at: string;
  };
  sales: EvidenceSales;
  matured: EvidenceMatured;
  variants: EvidenceVariant[];
  variants_total: number;
  inventory: EvidenceInventory[];
}

export interface StoreEvidence {
  orders: number;
  orders_unpaid: number;
  discount_orders: number;
  discount_amount: number;
  discount_gross: number;
  matured_orders: number;
  matured_total: number;
  matured_refunded: number;
  matured_orders_returned: number;
}

export interface EconomicsEvidence {
  as_of: string;
  params: { sales_window_days: number; discount_window_days: number; maturity_days: number; demand_window_days: number; recent_days: number };
  currency: string | null;
  taxes_included: boolean | null;
  /** When each synced domain was last complete. */
  freshness: Partial<Record<"catalog" | "orders" | "inventory" | "returns" | "customers", string | null>>;
  store: StoreEvidence;
  products: ProductEvidence[];
}

/** jsonb numerics may arrive as strings from some drivers: normalise every numeric field to a number (null stays null). */
export function normaliseEvidence(raw: EconomicsEvidence): EconomicsEvidence {
  const num = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).map(([k, v]) =>
    [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && !k.endsWith("_at") ? Number(v) : v])) as T;
  return {
    ...raw,
    store: num(raw.store),
    products: raw.products.map((p) => ({
      ...p,
      sales: num(p.sales),
      matured: num(p.matured),
      variants: p.variants.map((v) => ({ ...v, price: Number(v.price), compare_at_price: v.compare_at_price === null ? null : Number(v.compare_at_price),
        unit_cost: v.unit_cost === null ? null : Number(v.unit_cost) })),
    })),
  };
}
