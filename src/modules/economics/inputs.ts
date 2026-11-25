/**
 * The merchant's economics inputs (Phase 4, task 2; migration 0052) and how
 * one product's value is chosen: the product's own override, else the shop's
 * value, else unknown. Nothing here turns an unknown into a number.
 */
export const MERCHANT_INPUT_KEYS = [
  "payment_rate", "payment_fixed_fee", "selling_fee_rate", "shipping_cost_per_order", "fulfilment_cost_per_order",
  "fulfilment_cost_per_unit", "landed_cost_rate", "landed_cost_per_unit", "return_handling_cost",
  "expected_discount_rate", "expected_refund_rate", "expected_return_rate",
  "ad_monthly_limit", "ad_test_limit", "ad_daily_limit", "ad_max_loss", "advertising_excluded",
  // 0056: a confirmed zero unit cost (product or variant), and when Meta counts a purchase (0 placed, 1 paid).
  "unit_cost_zero_confirmed", "purchase_event_basis",
] as const;
export type MerchantInputKey = (typeof MERCHANT_INPUT_KEYS)[number];

/** Keys holding an amount of money, in the shop's currency when entered. */
export const MONEY_INPUT_KEYS: ReadonlySet<MerchantInputKey> = new Set([
  "payment_fixed_fee", "shipping_cost_per_order", "fulfilment_cost_per_order", "fulfilment_cost_per_unit",
  "landed_cost_per_unit", "return_handling_cost", "ad_monthly_limit", "ad_test_limit", "ad_daily_limit", "ad_max_loss",
]);

/** Where a figure came from (architecture/phase-4-economics.md, "Inputs, provenance and confidence"). */
export type Provenance = "observed" | "merchant_entered" | "confirmed_none" | "store_proxy" | "merchant_estimate" | "missing";

export interface StoredMerchantInput {
  product_id: number;
  /** 0056: 0 (or absent) for product- and shop-wide values; a variant's own value otherwise. */
  variant_id?: number;
  key: MerchantInputKey;
  value: number;
  state: "merchant_entered" | "confirmed_none" | "merchant_estimate";
  currency: string | null;
  entered_by: string;
  entered_at: string;
}

/** economics_inputs(): the shop's currency and its inputs. */
export interface StoredMerchantInputs {
  currency: string | null;
  inputs: StoredMerchantInput[];
}

export interface ResolvedInput {
  key: MerchantInputKey;
  /** Null when unknown. */
  value: number | null;
  state: Extract<Provenance, "merchant_entered" | "confirmed_none" | "merchant_estimate" | "missing">;
  scope: "product" | "shop" | null;
  entered_at: string | null;
  /** Older than the policy's merchant_inputs_stale_days. */
  stale: boolean;
  /** Why a stored value is not used. */
  unusable?: "currency_changed";
}

/** Keys added in 0056 may be absent from records made before it. */
export type ResolvedInputs = Record<Exclude<MerchantInputKey, "unit_cost_zero_confirmed" | "purchase_event_basis">, ResolvedInput>
  & Partial<Record<"unit_cost_zero_confirmed" | "purchase_event_basis", ResolvedInput>>;

/** One product's inputs: its override, else the shop's value, else missing. */
export function resolveMerchantInputs(
  stored: StoredMerchantInputs,
  productId: number,
  options: { now: Date; staleDays: number },
): ResolvedInputs {
  const staleBefore = options.now.getTime() - options.staleDays * 86_400_000;
  const pick = (key: MerchantInputKey): ResolvedInput => {
    const shared = stored.inputs.filter((i) => !i.variant_id);
    const row = shared.find((i) => i.key === key && i.product_id === productId && productId !== 0)
      ?? shared.find((i) => i.key === key && i.product_id === 0);
    if (!row) return { key, value: null, state: "missing", scope: null, entered_at: null, stale: false };
    const scope = row.product_id === 0 ? "shop" : "product";
    // Money entered in another currency (the shop's currency changed since) is not converted: it is unknown.
    if (MONEY_INPUT_KEYS.has(key) && (!stored.currency || row.currency !== stored.currency)) {
      return { key, value: null, state: "missing", scope, entered_at: row.entered_at, stale: false, unusable: "currency_changed" };
    }
    const value = Number(row.value);
    return { key, value, state: row.state, scope, entered_at: row.entered_at, stale: Date.parse(row.entered_at) < staleBefore };
  };
  return Object.fromEntries(MERCHANT_INPUT_KEYS.map((key) => [key, pick(key)])) as ResolvedInputs;
}

/** One product's per-variant inputs (0056): a confirmed zero unit cost, landed cost per unit. */
export function resolveVariantInputs(stored: StoredMerchantInputs, productId: number, options: { now: Date; staleDays: number }) {
  const staleBefore = options.now.getTime() - options.staleDays * 86_400_000;
  const out: Record<number, Partial<Record<"unit_cost_zero_confirmed" | "landed_cost_per_unit", ResolvedInput>>> = {};
  for (const row of stored.inputs) {
    if (row.product_id !== productId || !row.variant_id || (row.key !== "unit_cost_zero_confirmed" && row.key !== "landed_cost_per_unit")) continue;
    const unusable = MONEY_INPUT_KEYS.has(row.key) && (!stored.currency || row.currency !== stored.currency);
    out[row.variant_id] = { ...out[row.variant_id], [row.key]: unusable
      ? { key: row.key, value: null, state: "missing", scope: "product", entered_at: row.entered_at, stale: false, unusable: "currency_changed" }
      : { key: row.key, value: Number(row.value), state: row.state, scope: "product", entered_at: row.entered_at, stale: Date.parse(row.entered_at) < staleBefore } };
  }
  return out;
}
