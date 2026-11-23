import type { StoreReturnSignal } from "@/lib/store-data";

/**
 * Product data-quality flags (Phase 3, task 6). For each field Phase 4 relies
 * on, a state and the reason for it, from facts the database gathers
 * (product_quality_facts, migration 0049). Pure and versioned: the states keep
 * incomplete evidence apart from negative evidence, and nothing is filled in.
 *
 *   present      the value is stored, as Shopify gives it;
 *   empty        Shopify confirms there is none, and none is needed (no
 *                compare-at price: not on sale; a variant that is not shipped
 *                has no weight to know);
 *   missing      it could be read, but the merchant has not set it (no unit
 *                cost, no barcode, no category);
 *   unavailable  it could not be read (a scope, a domain not imported, a row
 *                read before the field was, or Shopify has no such field);
 *   unverified   a value is there, but it rests on a merchant's free-text
 *                signal, is incomplete, or contradicts itself.
 */
export const QUALITY_CALC_VERSION = 1;

export type QualityState = "present" | "empty" | "missing" | "unavailable" | "unverified";
export interface QualityFlag { state: QualityState; reason: string; detail?: string }
export const QUALITY_FIELDS = [
  "price", "compare_at_price", "unit_cost", "weight", "inventory", "fulfilment", "return_eligibility",
  "specifications", "description", "images", "category", "barcode", "customs",
] as const;
export type QualityField = (typeof QUALITY_FIELDS)[number];
export interface ProductQuality {
  calc_version: number;
  flags: Record<QualityField, QualityFlag>;
  counts: Record<QualityState, number>;
}

/** product_quality_facts's rows (0049). */
export interface ProductQualityFacts {
  product_id: number;
  status: string;
  fields_version: number | null;
  is_gift_card: boolean;
  collective: boolean;
  has_description: boolean;
  description_truncated: boolean | null;
  has_category: boolean;
  has_image: boolean;
  media_count: number | null;
  variants: number;
  zero_price: number;
  with_cost: number;
  cost_currencies: string[];
  shipped: number;
  shipped_without_weight: number;
  shipping_unknown: number;
  with_barcode: number;
  with_compare_at: number;
  compare_at_not_above: number;
  with_hs_code: number;
  with_origin: number;
  tracked: number;
  untracked: number;
  keep_selling: number;
  tracked_with_levels: number;
  levels: number;
  levels_unknown_location: number;
  levels_partial_quantities: number;
  levels_third_party: number;
  metafields: number;
  metafields_defined: number;
  metafields_truncated: number;
  references: number;
  references_unresolved: number;
}

/** What the shop allows to be known: its currency, granted scopes, and which domains were imported. */
export interface ShopQualityContext {
  currency: string | null;
  scopes: string[];
  inventoryImported: boolean;
  returnsImported: boolean;
}

const flag = (state: QualityState, reason: string, detail?: string): QualityFlag => (detail === undefined ? { state, reason } : { state, reason, detail });
const share = (part: number, whole: number) => `${part} of ${whole} variants`;

export function evaluateProductQuality(f: ProductQualityFacts, signals: StoreReturnSignal[], shop: ShopQualityContext): ProductQuality {
  const n = f.variants;
  const phase3 = f.fields_version !== null && f.fields_version >= 2;
  const scope = (name: string) => shop.scopes.length === 0 || shop.scopes.includes(name);
  const noVariants = flag("unavailable", "no_variants");
  const flags = {} as Record<QualityField, QualityFlag>;

  flags.price = n === 0 ? noVariants
    : f.zero_price > 0 ? flag("unverified", "zero_price", share(f.zero_price, n))
    : flag("present", "set");

  flags.compare_at_price = n === 0 ? noVariants
    : f.with_compare_at === 0 ? flag("empty", "not_on_sale")
    : f.compare_at_not_above > 0 ? flag("unverified", "not_above_price", share(f.compare_at_not_above, n))
    : flag("present", "on_sale", share(f.with_compare_at, n));

  const otherCurrency = shop.currency ? f.cost_currencies.filter((c) => c !== shop.currency) : [];
  flags.unit_cost = !scope("read_inventory") ? flag("unavailable", "scope_missing", "read_inventory")
    : n === 0 ? noVariants
    : f.with_cost === 0 ? flag("missing", "not_set")
    : f.with_cost < n ? flag("missing", "partial", share(f.with_cost, n))
    : otherCurrency.length ? flag("unverified", "currency_differs", otherCurrency.join(","))
    : flag("present", "set");

  flags.weight = f.is_gift_card ? flag("empty", "gift_card")
    : n === 0 ? noVariants
    : f.shipped === 0 && f.shipping_unknown === 0 ? flag("empty", "not_shipped")
    : f.shipped === 0 ? flag("unavailable", "shipping_unknown")
    : f.shipped_without_weight === f.shipped ? flag("missing", "not_set")
    : f.shipped_without_weight > 0 ? flag("missing", "partial", share(f.shipped - f.shipped_without_weight, f.shipped))
    : flag("present", "set");

  flags.inventory = n === 0 ? noVariants
    : f.untracked === n ? flag("empty", "untracked")
    : !scope("read_inventory") ? flag("unavailable", "scope_missing", "read_inventory")
    : !shop.inventoryImported ? flag("unavailable", "inventory_not_imported")
    : f.tracked_with_levels < f.tracked ? flag("unavailable", "no_level_stored", share(f.tracked - f.tracked_with_levels, f.tracked))
    : f.levels_partial_quantities > 0 ? flag("unverified", "quantities_partial")
    : flag("present", "levels");

  flags.fulfilment = f.collective ? flag("present", "shopify_collective")
    : f.levels === 0 ? (f.untracked === n && n > 0 ? flag("unavailable", "untracked_no_location") : flag("unavailable", "no_level_stored"))
    : f.levels_unknown_location > 0 ? flag("unverified", "unknown_location")
    : f.levels_third_party > 0 ? flag("present", "third_party")
    : flag("present", "merchant");

  const strongest = signals.find((s) => s.trust === "verified") ?? signals.find((s) => s.trust === "observed") ?? signals[0];
  flags.return_eligibility = strongest
    ? flag(strongest.trust === "unverified" ? "unverified" : "present", strongest.signal, strongest.detail ?? undefined)
    : !shop.returnsImported ? flag("unavailable", "returns_not_imported")
    // Shopify has no product-level return rule: without a signal, returnability is not known, not confirmed.
    : flag("unavailable", "no_product_rule");

  flags.specifications = !phase3 ? flag("unavailable", "not_read")
    : f.metafields === 0 ? flag("empty", "none_defined")
    : f.references_unresolved > 0 ? flag("unverified", "reference_unresolved", `${f.references_unresolved} of ${f.references}`)
    : f.metafields_truncated === f.metafields ? flag("unverified", "truncated")
    : f.metafields_defined === 0 ? flag("unverified", "no_definitions")
    : flag("present", "defined", `${f.metafields_defined} of ${f.metafields} defined`);

  flags.description = f.has_description
    ? flag("present", f.description_truncated ? "excerpt" : "set")
    : flag("empty", "none");

  flags.images = f.has_image ? flag("present", "featured")
    : !phase3 ? flag("unavailable", "not_read")
    : (f.media_count ?? 0) > 0 ? flag("missing", "no_featured")
    : flag("empty", "none");

  flags.category = f.has_category ? flag("present", "set") : flag("missing", "uncategorised");

  flags.barcode = f.is_gift_card ? flag("empty", "gift_card")
    : !phase3 ? flag("unavailable", "not_read")
    : n === 0 ? noVariants
    : f.with_barcode === 0 ? flag("missing", "not_set")
    : f.with_barcode < n ? flag("missing", "partial", share(f.with_barcode, n))
    : flag("present", "set");

  flags.customs = f.is_gift_card ? flag("empty", "gift_card")
    : !phase3 ? flag("unavailable", "not_read")
    : n === 0 ? noVariants
    : f.with_hs_code === n && f.with_origin === n ? flag("present", "set")
    : f.with_hs_code === 0 && f.with_origin === 0 ? flag("empty", "not_set")
    : flag("missing", "partial", `HS code: ${f.with_hs_code}, origin: ${f.with_origin} of ${n}`);

  const counts: Record<QualityState, number> = { present: 0, empty: 0, missing: 0, unavailable: 0, unverified: 0 };
  for (const field of QUALITY_FIELDS) counts[flags[field].state] += 1;
  return { calc_version: QUALITY_CALC_VERSION, flags, counts };
}
