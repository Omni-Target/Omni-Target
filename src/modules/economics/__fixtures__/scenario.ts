/**
 * Test fixtures: builds the evidence, merchant inputs and policy for an ILLUSTRATIVE product from a compact
 * description, so each test states its inputs plainly. Synthetic: no figure here is a real merchant's.
 */
import type { EconomicsEvidence, EvidenceInventory, ProductEvidence, StoreEvidence } from "../evidence";
import { MERCHANT_INPUT_KEYS, type MerchantInputKey, type ResolvedInput, type ResolvedInputs } from "../inputs";
import type { EconomicsPolicySettings } from "../policy";
import { POLICY_V1 } from "./policy-v1";

export interface ScenarioVariant {
  price: number;
  cost: number | null;
  /** Units sold in the window (the mix). */
  units?: number;
  costCurrency?: string;
  requiresShipping?: boolean;
  /** Online available stock; undefined: no level stored. */
  available?: number;
  tracked?: boolean;
  policy?: "deny" | "continue";
}

export interface Scenario {
  currency?: string | null;
  taxesIncluded?: boolean | null;
  productId?: number;
  status?: string;
  giftCard?: boolean;
  variants: ScenarioVariant[];
  /** Paid orders in the window; units per order = Σ variant units ÷ orders. */
  orders?: number;
  /** Orders placed, paid or not (defaults to orders). */
  ordersCreated?: number;
  /** Orders in the demand window and 30-day units (default: all orders, no recent units). */
  demandOrders?: number;
  recentUnits?: number;
  /** Observed discount rate on the product's orders (default 0). */
  discountRate?: number;
  /** Matured orders (default: all orders) and what happened to them. */
  maturedOrders?: number;
  refundRate?: number;
  refundedOrders?: number;
  restockedUnits?: number;
  returns?: number;
  /** Customer-paid shipping per order on single-product orders (default 0). */
  shippingPerOrder?: number;
  /** Tax as a share of the product's net line value (default 0). */
  taxShare?: number;
  store?: Partial<StoreEvidence>;
  /** Merchant inputs: a number (entered), "none" (confirmed none), or an estimate. */
  inputs?: Partial<Record<MerchantInputKey, number | "none" | { estimate: number }>>;
  policy?: Partial<EconomicsPolicySettings>;
}

/** The merchant inputs most tests share: every cost entered, so only what a test changes matters. */
export const COMPLETE_COSTS: NonNullable<Scenario["inputs"]> = {
  payment_rate: 0.025, payment_fixed_fee: 0.3, selling_fee_rate: "none", shipping_cost_per_order: 7, fulfilment_cost_per_order: 2,
  fulfilment_cost_per_unit: "none", landed_cost_rate: "none", return_handling_cost: 16,
};

export function buildScenario(s: Scenario) {
  const currency = s.currency === undefined ? "USD" : s.currency;
  const orders = s.orders ?? 0;
  const created = s.ordersCreated ?? orders;
  const variants = s.variants.map((v, i) => ({
    id: (s.productId ?? 1) * 100 + i + 1, title: `V${i + 1}`, price: v.price, compare_at_price: null, unit_cost: v.cost,
    unit_cost_currency: v.cost === null ? null : (v.costCurrency ?? currency), tracked: v.tracked ?? true, inventory_policy: v.policy ?? "deny",
    requires_shipping: v.requiresShipping ?? true, available_for_sale: true, units: v.units ?? 0, orders: 0, synced_at: "2026-11-24T00:00:00Z",
  }));
  const units = variants.reduce((t, v) => t + v.units, 0);
  const gross = variants.reduce((t, v) => t + v.price * v.units, 0);
  const discountRate = s.discountRate ?? 0;
  const discounts = gross * discountRate;
  const net = gross - discounts;
  const maturedOrders = s.maturedOrders ?? orders;
  const share = orders > 0 ? maturedOrders / orders : 0;
  const maturedNet = net * share;
  const refundedOrders = s.refundedOrders ?? 0;
  const product: ProductEvidence = {
    product_id: s.productId ?? 1,
    product: { title: "Illustrative product", status: s.status ?? "active", is_gift_card: s.giftCard ?? false, collective: false,
      online_store_url: "https://example.test/p", published_at: null, requires_selling_plan: false, fields_version: 2, created_at: null, synced_at: "2026-11-24T00:00:00Z" },
    sales: {
      orders_created: created, orders, orders_unpaid: created - orders, units, gross, discounts, net,
      demand_orders: s.demandOrders ?? orders, demand_units: units, recent_units: s.recentUnits ?? 0,
      discount_orders: orders, discount_gross: gross, discount_amount: discounts,
      single_orders: orders, single_orders_unrefunded: orders, single_shipping: (s.shippingPerOrder ?? 0) * orders,
      multi_orders: 0, multi_orders_unrefunded: 0, multi_shipping_allocated: 0,
      orders_with_tax: s.taxShare ? orders : 0, allocated_tax: net * (s.taxShare ?? 0),
    },
    matured: {
      orders: maturedOrders, units: units * share, net: maturedNet, refunded_amount: maturedNet * (s.refundRate ?? 0),
      refunded_units: refundedOrders, returned_restocked_units: s.restockedUnits ?? 0, cancelled_restocked_units: 0,
      orders_refunded: refundedOrders, returns: s.returns ?? 0, returned_units: s.returns ?? 0, refunds_unread: 0, returns_unread: 0,
    },
    variants,
    variants_total: variants.length,
    inventory: variants.map((v, i): EvidenceInventory => {
      const sv = s.variants[i];
      const state = sv.tracked === false ? "untracked" : sv.available === undefined ? "unknown" : sv.available > 0 ? "in_stock"
        : sv.policy === "continue" ? "oversell_allowed" : "out_of_stock";
      return { variant_id: v.id, state, tracked: v.tracked, inventory_policy: v.inventory_policy, quantities_read: true,
        online: { locations: sv.available === undefined ? 0 : 1, available: sv.available ?? null, committed: 0, incoming: 0, unavailable: 0, on_hand: sv.available ?? null },
        unknown_locations: 0, collective: false, fulfilment: ["merchant"] };
    }),
  };
  const store: StoreEvidence = {
    orders: 0, orders_unpaid: 0, tax_amount: 0, tax_base: 0, discount_orders: 0, discount_amount: 0, discount_gross: 0,
    matured_orders: 0, matured_total: 0, matured_refunded: 0, matured_orders_returned: 0, ...s.store,
  };
  const evidence: EconomicsEvidence = {
    as_of: "2026-11-24T00:00:00Z", params: { sales_window_days: 365, discount_window_days: 180, maturity_days: 60, demand_window_days: 180, recent_days: 30 },
    currency, taxes_included: s.taxesIncluded === undefined ? false : s.taxesIncluded,
    freshness: { inventory: "2026-11-24T00:00:00Z", orders: "2026-11-24T00:00:00Z", catalog: "2026-11-24T00:00:00Z" },
    store, products: [product],
  };
  const inputs = Object.fromEntries(MERCHANT_INPUT_KEYS.map((key): [MerchantInputKey, ResolvedInput] => {
    const v = s.inputs?.[key];
    if (v === undefined) return [key, { key, value: null, state: "missing", scope: null, entered_at: null, stale: false }];
    if (v === "none") return [key, { key, value: 0, state: "confirmed_none", scope: "shop", entered_at: "2026-11-01T00:00:00Z", stale: false }];
    if (typeof v === "object") return [key, { key, value: v.estimate, state: "merchant_estimate", scope: "shop", entered_at: "2026-11-01T00:00:00Z", stale: false }];
    return [key, { key, value: v, state: "merchant_entered", scope: "shop", entered_at: "2026-11-01T00:00:00Z", stale: false }];
  })) as ResolvedInputs;
  const policy: EconomicsPolicySettings = { ...POLICY_V1.settings, ...s.policy };
  return { evidence, product, inputs, policy };
}

/** The illustrative healthy product: $80 price, $72 net revenue, $30 contribution (architecture/phase-4-economics.md). */
export const HEALTHY_80: Scenario = {
  variants: [{ price: 80, cost: 30, units: 100, available: 500 }],
  orders: 100, discountRate: 0.05, maturedOrders: 100, refundRate: 4 / 76, refundedOrders: 5, returns: 5,
  inputs: COMPLETE_COSTS,
};
