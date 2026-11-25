/**
 * Contribution economics per acquired order (Phase 4, task 4; architecture/phase-4-economics.md,
 * "Contribution per acquired order" and "Acquisition metrics").
 *
 * Pure and deterministic: evidence (task 3), the merchant's inputs and a policy version in, one product's
 * economics out. Every line carries where it came from. Money is computed in whole minor units: revenue
 * rounds down, costs and reductions round up, ceilings round down, so rounding never raises a ceiling.
 * A missing essential input yields no contribution at all, only an upper bound from what is known.
 */
import { money, rate6 } from "./money";
import { exactBinomialBounds, wilsonBounds } from "./stats";
import type { EconomicsEvidence, EvidenceVariant, ProductEvidence } from "./evidence";
import type { MerchantInputKey, Provenance, ResolvedInput, ResolvedInputs } from "./inputs";
import type { EconomicsPolicySettings } from "./policy";
import type { ReasonCode } from "./reasons";

export const ECONOMICS_CALC_VERSION = "econ-1.0.0" as const;
/** Policy version 2 (migration 0056) switches on the finalisation rules; records made under version 1 recompute unchanged. */
export const ECONOMICS_CALC_VERSION_V2 = "econ-1.1.0" as const;
/** Inputs a merchant can give per variant (0056). */
export type VariantInputs = Record<number, Partial<Record<"unit_cost_zero_confirmed" | "landed_cost_per_unit", ResolvedInput>>>;

export const REVENUE_LINES = ["gross_revenue", "discounts", "refunds", "tax_included", "shipping_revenue", "net_revenue"] as const;
export const COST_LINES = ["product_cost", "landed_cost", "shipping_cost", "fulfilment_cost", "payment_fees", "selling_fees", "return_handling"] as const;
export type CostLine = (typeof COST_LINES)[number];
export type LineKey = (typeof REVENUE_LINES)[number] | CostLine | "variable_costs" | "contribution";

/** Where a figure came from; "derived" is computed from others or a stated conservative assumption. */
export type Source = Provenance | "derived";

export interface EconomicsLine {
  /** Per acquired order, in the shop's currency; null when unknown. */
  amount: number | null;
  provenance: Source;
  basis: string;
}

export interface RateEvidence {
  value: number | null;
  provenance: Source;
  /** Orders (or units) the figure rests on. */
  sample: number | null;
  basis: string;
  /** The value at the unfavourable end of its range, used for the maximum viable CPA. */
  stress: number | null;
}

export interface ProductEconomics {
  calc_version: typeof ECONOMICS_CALC_VERSION | typeof ECONOMICS_CALC_VERSION_V2;
  product_id: number;
  currency: string | null;
  units_per_order: number;
  price_per_unit: number | null;
  unit_cost_per_unit: number | null;
  requires_shipping: boolean;
  rates: Record<"discount" | "refund" | "recovery" | "return_incidence" | "tax_share" | "paid_share", RateEvidence>;
  /** Customer-paid shipping per acquired order, as money (not a ratio). */
  shipping_revenue: RateEvidence;
  lines: Record<LineKey, EconomicsLine>;
  net_revenue: number | null;
  variable_costs: number | null;
  contribution: number | null;
  contribution_margin: number | null;
  /** What the customer is charged per order (product after discounts, tax charged on top, shipping): the pixel's purchase value. */
  charged_per_order: number | null;
  /** Break-even per purchase as the ad platform counts it (see purchase_event_basis). */
  break_even_cpa: number | null;
  /** Break-even per order actually paid (policy version 2): the effective cost per paid order must stay under it. */
  break_even_cpa_per_paid_order?: number | null;
  /** When the platform counts a purchase: when placed, only when paid, or unconfirmed (the lower break-even is used). */
  purchase_event_basis?: "placed" | "paid" | "unconfirmed";
  /** Failed deliveries per order placed (shipped, never paid), and what one costs (policy version 2). */
  failed_delivery?: { share: number; cost_per_failure: number | null; source: Source } | null;
  maximum_viable_cpa: number | null;
  target_cpa: number | null;
  break_even_roas: number | null;
  target_roas: number | null;
  /** Target ROAS on the purchase value an ad platform reports (amount charged), so it compares with Meta's figure. */
  platform_target_roas: number | null;
  /** With inputs missing: known revenue − known costs, an upper bound on contribution. ≤ 0 means unviable whatever is missing. */
  contribution_upper_bound: number | null;
  /** Essential inputs missing or unreliable. */
  missing: ReasonCode[];
  /** Evidence notes: proxies, estimates, assumptions. */
  notes: ReasonCode[];
}

export interface ContributionArgs {
  evidence: Pick<EconomicsEvidence, "currency" | "taxes_included" | "store">;
  product: ProductEvidence;
  inputs: ResolvedInputs;
  policy: EconomicsPolicySettings;
  /** Per-variant inputs (0056): a confirmed zero cost, landed cost per unit. */
  variantInputs?: VariantInputs;
}

/** Rates keep full precision: rounding a rate before applying it could move a cost by a minor unit. Display rounds. */
const rate = (value: number | null, provenance: Source, sample: number | null, basis: string, stress: number | null = value): RateEvidence =>
  ({ value, provenance, sample, basis, stress: stress === null ? null : Math.min(1, Math.max(0, stress)) });

/** The price mix: variants that sold in the window, by units; else equal weights over sellable variants. */
function variantMix(variants: EvidenceVariant[]) {
  const sold = variants.filter((v) => v.units > 0);
  const sellable = variants.filter((v) => v.available_for_sale !== false);
  const mix = sold.length ? sold : sellable.length ? sellable : variants;
  const totalUnits = sold.reduce((t, v) => t + v.units, 0);
  return mix.map((v) => ({ variant: v, weight: sold.length ? v.units / totalUnits : 1 / mix.length }));
}

export function computeProductEconomics({ evidence, product, inputs, policy, variantInputs }: ContributionArgs): ProductEconomics {
  const missing = new Set<ReasonCode>();
  const notes = new Set<ReasonCode>();
  const currency = evidence.currency;
  if (currency === null) missing.add("SHOP_CURRENCY_UNKNOWN");
  const { sales, matured } = product;
  const store = evidence.store;
  const confidence = policy.decision_confidence;
  // Policy version 2 (0056): the finalisation rules. Without its keys the engine behaves exactly as econ-1.0.0.
  const v2 = policy.estimate_downside_factor !== undefined;
  const downside = policy.estimate_downside_factor ?? 1;
  // Version 2 bounds proportions exactly (Clopper–Pearson); version 1 records keep the Wilson bounds they were made with.
  const proportionBounds = v2 ? exactBinomialBounds : wilsonBounds;
  const confirmedZero = (variantId: number) => variantInputs?.[variantId]?.unit_cost_zero_confirmed?.value === 1
    || inputs.unit_cost_zero_confirmed?.value === 1;

  // ── The price mix and unit cost ──
  const mix = variantMix(product.variants);
  if (!mix.length || mix.every(({ variant }) => !(variant.price > 0))) missing.add("PRICE_UNKNOWN");
  const pricePerUnit = mix.reduce((t, { variant, weight }) => t + weight * variant.price, 0);
  const withoutCost = mix.filter(({ variant }) => variant.unit_cost === null);
  if (mix.length && withoutCost.length === mix.length) missing.add("UNIT_COST_MISSING");
  else if (withoutCost.length) missing.add("UNIT_COST_PARTIAL");
  // A zero unit cost is a missing cost unless the merchant confirmed it for the variant or the product (0056).
  if (mix.some(({ variant }) => variant.unit_cost === 0 && !confirmedZero(variant.id))) missing.add("UNIT_COST_ZERO");
  else if (mix.some(({ variant }) => variant.unit_cost === 0)) notes.add("UNIT_COST_ZERO_CONFIRMED");
  if (currency && mix.some(({ variant }) => variant.unit_cost !== null && variant.unit_cost_currency !== currency)) missing.add("UNIT_COST_CURRENCY_MISMATCH");
  const unitCostKnown = !["UNIT_COST_MISSING", "UNIT_COST_PARTIAL", "UNIT_COST_ZERO", "UNIT_COST_CURRENCY_MISMATCH"].some((c) => missing.has(c as ReasonCode));
  // The known part of the weighted cost: the cost itself when complete, a lower bound otherwise.
  const unitCost = mix.filter(({ variant }) => variant.unit_cost !== null && variant.unit_cost_currency === currency)
    .reduce((t, { variant, weight }) => t + weight * (variant.unit_cost as number), 0);
  const requiresShipping = mix.some(({ variant }) => variant.requires_shipping !== false);

  const unitsPerOrder = sales.orders > 0 ? sales.units / sales.orders : 1;
  if (sales.orders === 0) { notes.add("NO_SALES_HISTORY"); notes.add("SINGLE_UNIT_ASSUMED"); }
  else if (sales.orders < policy.medium_confidence_orders) notes.add("SALES_SAMPLE_SMALL");

  // ── Rates: the product's own, else the store's, else the merchant's estimate, else unknown ──
  let discount: RateEvidence;
  if (sales.discount_orders >= policy.product_discount_min_orders && sales.discount_gross > 0) {
    discount = rate(sales.discount_amount / sales.discount_gross, "observed", sales.discount_orders, `the product's discounts over ${policy.discount_window_days} days`);
  } else if (store.discount_orders >= policy.store_proxy_min_matured_orders && store.discount_gross > 0) {
    discount = rate(store.discount_amount / store.discount_gross, "store_proxy", store.discount_orders, `the store's discounts over ${policy.discount_window_days} days`,
      (store.discount_amount / store.discount_gross) * downside);
    notes.add("DISCOUNT_RATE_STORE_PROXY");
  } else if (inputs.expected_discount_rate.value !== null) {
    discount = rate(inputs.expected_discount_rate.value, "merchant_estimate", null, "the merchant's expected discount rate", inputs.expected_discount_rate.value * downside);
    notes.add("DISCOUNT_RATE_MERCHANT_ESTIMATE");
  } else {
    discount = rate(null, "missing", null, "no discount history and no estimate");
    missing.add("DISCOUNT_RATE_UNKNOWN");
  }

  const productRefundsUsable = matured.orders >= policy.product_refund_min_matured_orders && matured.refunded_amount !== null && matured.net > 0;
  if (matured.orders >= policy.product_refund_min_matured_orders && matured.refunded_amount === null) notes.add("REFUND_EVIDENCE_INCOMPLETE");
  let refund: RateEvidence;
  let recovery: RateEvidence;
  if (productRefundsUsable) {
    const value = (matured.refunded_amount as number) / matured.net;
    const refundedOrders = matured.orders_refunded ?? 0;
    const incidence = refundedOrders / matured.orders;
    const upper = proportionBounds(refundedOrders, matured.orders, confidence).upper;
    // The amount refunded scales with how many orders are refunded; with none seen, full refunds at the bound.
    refund = rate(value, "observed", matured.orders, `refunds on the product's matured orders (${refundedOrders} of ${matured.orders} refunded)`,
      incidence > 0 ? value * (upper / incidence) : upper);
    const recovered = (matured.returned_restocked_units ?? 0) + (matured.cancelled_restocked_units ?? 0);
    recovery = rate(matured.units > 0 ? recovered / matured.units : 0, "observed", matured.units, "units refunded and restocked, per unit sold",
      matured.units > 0 ? proportionBounds(recovered, matured.units, confidence).lower : 0);
  } else {
    if (store.matured_orders >= policy.store_proxy_min_matured_orders && store.matured_total > 0) {
      refund = rate(store.matured_refunded / store.matured_total, "store_proxy", store.matured_orders, "the store's refunds on matured orders",
        (store.matured_refunded / store.matured_total) * downside);
      notes.add("RETURN_RATE_STORE_PROXY");
    } else if (inputs.expected_refund_rate.value !== null) {
      refund = rate(inputs.expected_refund_rate.value, "merchant_estimate", null, "the merchant's expected refund rate", inputs.expected_refund_rate.value * downside);
      notes.add("RETURN_RATE_MERCHANT_ESTIMATE");
    } else {
      refund = rate(null, "missing", null, "no matured refund history and no estimate");
      missing.add("RETURN_RATE_UNVERIFIED");
    }
    recovery = rate(0, "derived", null, "refunded units assumed not restocked");
    if (refund.value !== null && refund.value > 0) notes.add("RECOVERY_NOT_ASSUMED");
  }

  let returnIncidence: RateEvidence;
  if (productRefundsUsable && matured.returns !== null) {
    returnIncidence = rate(matured.returns / matured.orders, "observed", matured.orders, "returns per matured order",
      proportionBounds(matured.returns, matured.orders, confidence).upper);
  } else if (store.matured_orders >= policy.store_proxy_min_matured_orders) {
    returnIncidence = rate(store.matured_orders_returned / store.matured_orders, "store_proxy", store.matured_orders, "the store's returns per matured order",
      (store.matured_orders_returned / store.matured_orders) * downside);
  } else if (inputs.expected_return_rate.value !== null) {
    returnIncidence = rate(inputs.expected_return_rate.value, "merchant_estimate", null, "the merchant's expected returns per order", inputs.expected_return_rate.value * downside);
  } else {
    returnIncidence = rate(null, "missing", null, "no matured return history and no estimate");
  }
  const handling = inputs.return_handling_cost;
  const handlingNone = handling.state === "confirmed_none";
  if (returnIncidence.value === null && !handlingNone) missing.add("RETURN_RATE_UNVERIFIED");
  if (returnIncidence.value !== null && returnIncidence.value > 0 && handling.value === null) missing.add("RETURN_COST_MISSING");

  // ── Tax ──
  const taxIncluded = evidence.taxes_included !== false;
  if (evidence.taxes_included === null) notes.add("TAX_TREATMENT_ASSUMED_INCLUDED");
  let taxShare: RateEvidence;
  if (sales.orders > 0 && sales.net > 0) {
    taxShare = rate(sales.allocated_tax / sales.net, "observed", sales.orders, taxIncluded ? "tax inside the product's line prices" : "tax charged on top of the product's line prices");
    if (sales.allocated_tax > 0) notes.add("TAX_ALLOCATED");
  } else if (store.orders > 0 && store.tax_base > 0) {
    taxShare = rate(store.tax_amount / store.tax_base, "store_proxy", store.orders, "the store's tax on its orders");
  } else if (taxIncluded) {
    taxShare = rate(null, "missing", null, "prices include tax, but no order shows how much");
    missing.add("TAX_RATE_UNKNOWN");
  } else {
    taxShare = rate(0, "derived", null, "no order shows tax charged on top");
    notes.add("TAX_UNOBSERVED");
  }

  // ── Customer-paid shipping per acquired order (orders with any refund count as having refunded it) ──
  let shipping: RateEvidence;
  if (sales.single_orders > 0) {
    shipping = { value: sales.single_shipping / sales.single_orders, provenance: "observed", sample: sales.single_orders,
      basis: "shipping paid on orders holding only this product", stress: null };
  } else if (sales.multi_orders > 0) {
    shipping = { value: sales.multi_shipping_allocated / sales.multi_orders, provenance: "observed", sample: sales.multi_orders,
      basis: "shipping allocated from orders holding other products", stress: null };
    notes.add("SHIPPING_REVENUE_ALLOCATED");
  } else {
    shipping = { value: 0, provenance: "derived", sample: null, basis: "none counted: no order shows it", stress: null };
    if (requiresShipping) notes.add("SHIPPING_REVENUE_UNOBSERVED");
  }

  // ── Orders that are never paid: acquisition cost is per order placed ──
  let paidShare: RateEvidence;
  const storePlaced = store.orders + store.orders_unpaid;
  if (sales.orders_created >= policy.medium_confidence_orders) {
    paidShare = rate(sales.orders / sales.orders_created, "observed", sales.orders_created, "the product's orders that were paid",
      proportionBounds(sales.orders, sales.orders_created, confidence).lower);
  } else if (storePlaced >= policy.store_proxy_min_matured_orders) {
    paidShare = rate(store.orders / storePlaced, "store_proxy", storePlaced, "the store's orders that were paid");
  } else {
    paidShare = rate(1, "derived", null, "no order history: all orders assumed paid");
    notes.add("UNPAID_SHARE_UNOBSERVED");
  }
  if (!v2 && (paidShare.value ?? 1) < 1) notes.add("UNPAID_ORDERS_ADJUSTED");
  if (v2 && [discount, refund, returnIncidence].some((r) => (r.provenance === "store_proxy" || r.provenance === "merchant_estimate") && (r.value ?? 0) > 0)) {
    notes.add("ESTIMATE_DOWNSIDE_APPLIED");
  }

  // ── Version 2: what became of matured orders placed. Paid share and failed deliveries come from the product's own
  //    matured orders, else the store's; the old paid share (all orders in the window, recent unpaid ones included) is
  //    kept only for version-1 records. ──
  let outcomes: { paid: RateEvidence; failed: RateEvidence } | null = null;
  if (v2) {
    const own = (matured.placed ?? 0) >= policy.medium_confidence_orders;
    const storeOk = (store.matured_placed ?? 0) >= policy.store_proxy_min_matured_orders;
    if (own) {
      const placed = matured.placed as number;
      outcomes = {
        paid: rate((matured.paid ?? 0) / placed, "observed", placed, "the product's matured orders that were paid", proportionBounds(matured.paid ?? 0, placed, confidence).lower),
        failed: rate((matured.unpaid_shipped ?? 0) / placed, "observed", placed, "the product's matured orders shipped but never paid",
          proportionBounds(matured.unpaid_shipped ?? 0, placed, confidence).upper),
      };
    } else if (storeOk) {
      const placed = store.matured_placed as number;
      const paidValue = (store.matured_paid ?? 0) / placed;
      const failedValue = (store.matured_unpaid_shipped ?? 0) / placed;
      outcomes = {
        paid: rate(paidValue, "store_proxy", placed, "the store's matured orders that were paid", 1 - (1 - paidValue) * downside),
        failed: rate(failedValue, "store_proxy", placed, "the store's matured orders shipped but never paid", failedValue * downside),
      };
    } else {
      outcomes = { paid: rate(1, "derived", null, "no matured order history: all orders assumed paid"), failed: rate(0, "derived", null, "no matured order history") };
      notes.add("UNPAID_SHARE_UNOBSERVED");
    }
    paidShare = outcomes.paid;
    if ((outcomes.failed.value ?? 0) > 0) notes.add("FAILED_DELIVERIES_COUNTED");
  }

  // ── The merchant's costs ──
  const read = (input: ResolvedInput) => {
    if (input.unusable === "currency_changed") notes.add("COST_SETTINGS_CURRENCY_CHANGED");
    if (input.stale) notes.add("COST_SETTINGS_STALE");
    return input.value;
  };
  const need = (keys: MerchantInputKey[], code: ReasonCode) => {
    const values = keys.map((k) => read(inputs[k] as ResolvedInput));
    if (values.some((v) => v === null)) missing.add(code);
    return values;
  };
  const [paymentRate, paymentFixed] = need(["payment_rate", "payment_fixed_fee"], "PAYMENT_FEES_MISSING");
  const [sellingRate] = need(["selling_fee_rate"], "SELLING_FEES_UNCONFIRMED");
  const [shipCost] = requiresShipping ? need(["shipping_cost_per_order"], "SHIPPING_COST_MISSING") : [0];
  const [fulfilOrder, fulfilUnit] = need(["fulfilment_cost_per_order", "fulfilment_cost_per_unit"], "FULFILMENT_COST_MISSING");
  const landedPerUnit = read(inputs.landed_cost_per_unit);
  const landedRate = landedPerUnit === null ? read(inputs.landed_cost_rate) : null;
  // Landed cost per variant (0056): a variant's own per-unit figure, else the product's, else the rate on its unit cost.
  // Each unit carries one landed cost, so nothing is counted twice; the weighted figure follows the variant mix.
  const variantLanded = variantInputs && mix.some(({ variant }) => variantInputs[variant.id]?.landed_cost_per_unit?.value != null)
    ? mix.map(({ variant, weight }) => {
        const own = variantInputs[variant.id]?.landed_cost_per_unit?.value ?? null;
        const each = own ?? landedPerUnit ?? (landedRate !== null && variant.unit_cost !== null ? variant.unit_cost * landedRate : null);
        return each === null ? null : weight * each;
      })
    : null;
  const variantLandedPerUnit = variantLanded && variantLanded.every((v) => v !== null) ? (variantLanded as number[]).reduce((a, b) => a + b, 0) : null;
  if (variantLanded ? variantLandedPerUnit === null : landedPerUnit === null && landedRate === null) missing.add("LANDED_COST_UNCONFIRMED");
  const handlingCost = handlingNone ? 0 : read(handling);

  if (v2 && (outcomes?.failed.value ?? 0) > 0 && handlingCost === null) missing.add("RETURN_COST_MISSING");
  const ready = missing.size === 0;
  const m = money(currency ?? "USD");
  const z = (x: number | null) => x ?? 0;

  // ── One pass of the formula, in minor units. Unknown values count as zero: callers use the result only when
  //    everything is known, or as an upper bound on contribution (zero reductions and costs are the best case). ──
  const compute = (v: { discount: number; refund: number; recovery: number; incidence: number }) => {
    const gross = m.down(pricePerUnit * unitsPerOrder);
    const discounts = m.up(m.major(gross) * v.discount);
    const afterDiscount = gross - discounts;
    const refunds = m.up(m.major(afterDiscount) * v.refund);
    const t = z(taxShare.value);
    const taxInside = taxIncluded ? m.up(m.major(afterDiscount - refunds) * t) : 0;
    const shippingRevenue = m.down(z(shipping.value));
    const net = afterDiscount - refunds - taxInside + shippingRevenue;
    const taxOnTop = taxIncluded ? 0 : m.up(m.major(afterDiscount) * t);
    const charged = afterDiscount + taxOnTop + shippingRevenue;
    const kept = unitsPerOrder * (1 - v.recovery);
    const costs: Record<CostLine, number> = {
      product_cost: m.up(unitCost * kept),
      landed_cost: variantLanded ? m.up(z(variantLandedPerUnit) * kept) : landedPerUnit !== null ? m.up(landedPerUnit * kept) : m.up(unitCost * z(landedRate) * kept),
      shipping_cost: requiresShipping ? m.up(z(shipCost)) : 0,
      fulfilment_cost: m.up(z(fulfilOrder) + z(fulfilUnit) * unitsPerOrder),
      payment_fees: m.up(z(paymentRate) * m.major(charged) + z(paymentFixed)),
      selling_fees: m.up(z(sellingRate) * Math.max(0, m.major(net))),
      return_handling: m.up(v.incidence * z(handlingCost)),
    };
    const variable = Object.values(costs).reduce((a, b) => a + b, 0);
    return { gross, discounts, refunds, taxInside, shippingRevenue, net, charged, costs, variable, contribution: net - variable };
  };
  const point = compute({ discount: z(discount.value), refund: z(refund.value), recovery: z(recovery.value), incidence: z(returnIncidence.value) });

  // ── The lines, each with its source ──
  const lines = {} as Record<LineKey, EconomicsLine>;
  const set = (key: LineKey, minor: number | null, provenance: Source, basis: string) => {
    lines[key] = { amount: minor === null ? null : m.major(minor), provenance, basis };
  };
  const merchant = (...keys: MerchantInputKey[]): Source => {
    const states = keys.map((k) => (inputs[k] as ResolvedInput).state);
    return states.includes("missing") ? "missing" : states.includes("merchant_estimate") ? "merchant_estimate"
      : states.every((s) => s === "confirmed_none") ? "confirmed_none" : "merchant_entered";
  };
  const when = (ok: boolean, minor: number) => (ok ? minor : null);
  set("gross_revenue", when(!missing.has("PRICE_UNKNOWN") && currency !== null, point.gross), "observed",
    `current price × ${rate6(unitsPerOrder)} unit(s) per order, ${product.variants.some((v) => v.units > 0) ? "weighted by variants sold" : "variants weighted equally"}`);
  set("discounts", when(discount.value !== null, point.discounts), discount.provenance, discount.basis);
  set("refunds", when(refund.value !== null, point.refunds), refund.provenance, refund.basis);
  set("tax_included", when(taxShare.value !== null, point.taxInside), taxIncluded ? taxShare.provenance : "derived", taxIncluded ? taxShare.basis : "prices exclude tax");
  set("shipping_revenue", point.shippingRevenue, shipping.provenance, shipping.basis);
  set("product_cost", when(unitCostKnown, point.costs.product_cost), unitCostKnown ? "observed" : "missing", "Shopify unit cost × units kept (not restocked after a refund)");
  set("landed_cost", when(variantLanded ? variantLandedPerUnit !== null : landedPerUnit !== null || landedRate !== null, point.costs.landed_cost),
    variantLanded ? "merchant_entered" : landedPerUnit !== null ? inputs.landed_cost_per_unit.state : inputs.landed_cost_rate.state,
    variantLanded ? "per unit, by variant" : landedPerUnit !== null ? "per unit" : "share of unit cost (already in the unit cost when confirmed none)");
  set("shipping_cost", requiresShipping ? when(shipCost !== null, point.costs.shipping_cost) : 0,
    requiresShipping ? merchant("shipping_cost_per_order") : "derived", requiresShipping ? "per order" : "nothing to ship");
  set("fulfilment_cost", when(fulfilOrder !== null && fulfilUnit !== null, point.costs.fulfilment_cost),
    merchant("fulfilment_cost_per_order", "fulfilment_cost_per_unit"), "per order + per unit");
  set("payment_fees", when(paymentRate !== null && paymentFixed !== null, point.costs.payment_fees), merchant("payment_rate", "payment_fixed_fee"),
    "rate × amount charged + fixed fee; not returned on refunds");
  set("selling_fees", when(sellingRate !== null, point.costs.selling_fees), merchant("selling_fee_rate"), "rate × net revenue");
  set("return_handling", when(handlingNone || (returnIncidence.value !== null && (returnIncidence.value === 0 || handlingCost !== null)), point.costs.return_handling),
    handlingNone ? "confirmed_none" : handling.state === "missing" ? returnIncidence.provenance : merchant("return_handling_cost"),
    "returns per order × handling cost per return");
  set("net_revenue", when(ready, point.net), "derived", "gross − discounts − refunds − tax inside prices + customer-paid shipping");
  set("variable_costs", when(ready, point.variable), "derived", "sum of the costs");
  set("contribution", when(ready, point.contribution), "derived", "net revenue − variable costs");

  // ── Acquisition metrics ──
  const paid = paidShare.value ?? 1;
  let breakEven: number | null = null;
  let maximumViable: number | null = null;
  let target: number | null = null;
  let perPaidOrder: number | null = null;
  let basis: ProductEconomics["purchase_event_basis"];
  let revenueFactor = paid;
  let failedCost: number | null = null;
  if (ready && !v2) {
    breakEven = point.contribution > 0 ? m.down(m.major(point.contribution) * paid) : 0;
    const stress = compute({ discount: z(discount.stress), refund: z(refund.stress), recovery: z(recovery.stress), incidence: z(returnIncidence.stress) });
    const stressed = stress.contribution > 0 ? m.down(m.major(stress.contribution) * (paidShare.stress ?? paid)) : 0;
    maximumViable = Math.min(breakEven, stressed);
    target = breakEven > 0 ? Math.min(m.down(m.major(breakEven) * (1 - policy.contribution_reserve)), maximumViable) : 0;
  } else if (ready && outcomes) {
    // A failed delivery costs the outbound shipping and fulfilment and the parcel's return; the product comes back.
    failedCost = z(shipCost) * (requiresShipping ? 1 : 0) + z(fulfilOrder) + z(fulfilUnit) * unitsPerOrder + z(handlingCost);
    const choose = (c: number, p: number, f: number) => {
      // Per purchase counted when paid: each paid order also carries the failed deliveries the campaign brings.
      const perPaid = p > 0 ? c - (f / p) * failedCost! : -Infinity;
      // Per purchase counted when placed (a browser pixel at checkout counts unpaid cash-on-delivery orders too).
      const perPlaced = p * c - f * failedCost!;
      const chosen = inputs.purchase_event_basis?.value;
      const b: "paid" | "placed" = chosen === 1 ? "paid" : chosen === 0 ? "placed" : perPaid <= perPlaced ? "paid" : "placed";
      return { perPaid, reported: b === "paid" ? perPaid : perPlaced, basis: b };
    };
    const c = m.major(point.contribution);
    const now = choose(c, z(outcomes.paid.value), z(outcomes.failed.value));
    const stress = compute({ discount: z(discount.stress), refund: z(refund.stress), recovery: z(recovery.stress), incidence: z(returnIncidence.stress) });
    const stressedNow = choose(m.major(stress.contribution), z(outcomes.paid.stress ?? outcomes.paid.value), z(outcomes.failed.stress ?? outcomes.failed.value));
    basis = inputs.purchase_event_basis?.value === 1 ? "paid" : inputs.purchase_event_basis?.value === 0 ? "placed" : "unconfirmed";
    if (basis === "unconfirmed") notes.add("PURCHASE_EVENT_BASIS_UNCONFIRMED");
    if (now.basis === "placed" && z(outcomes.paid.value) < 1) notes.add("UNPAID_ORDERS_ADJUSTED");
    revenueFactor = now.basis === "placed" ? z(outcomes.paid.value) : 1;
    breakEven = now.reported > 0 ? m.down(now.reported) : 0;
    perPaidOrder = now.perPaid > 0 ? m.down(now.perPaid) : 0;
    const stressed = stressedNow.reported > 0 ? m.down(stressedNow.reported) : 0;
    maximumViable = Math.min(breakEven, stressed);
    target = breakEven > 0 ? Math.min(m.down(m.major(breakEven) * (1 - policy.contribution_reserve)), maximumViable) : 0;
  }
  const ratio = (a: number, b: number) => Math.round((a / b) * 1e4) / 1e4;

  return {
    calc_version: v2 ? ECONOMICS_CALC_VERSION_V2 : ECONOMICS_CALC_VERSION,
    product_id: product.product_id,
    currency,
    units_per_order: rate6(unitsPerOrder),
    price_per_unit: missing.has("PRICE_UNKNOWN") || currency === null ? null : m.major(m.down(pricePerUnit)),
    unit_cost_per_unit: unitCostKnown && currency !== null ? m.major(m.up(unitCost)) : null,
    requires_shipping: requiresShipping,
    rates: { discount, refund, recovery, return_incidence: returnIncidence, tax_share: taxShare, paid_share: paidShare },
    shipping_revenue: { ...shipping, value: currency === null ? null : m.major(m.down(z(shipping.value))) },
    lines,
    net_revenue: ready ? m.major(point.net) : null,
    variable_costs: ready ? m.major(point.variable) : null,
    contribution: ready ? m.major(point.contribution) : null,
    contribution_margin: ready && point.net > 0 ? ratio(point.contribution, point.net) : null,
    charged_per_order: ready ? m.major(point.charged) : null,
    break_even_cpa: breakEven === null ? null : m.major(breakEven),
    ...(v2 ? {
      break_even_cpa_per_paid_order: perPaidOrder === null ? null : m.major(perPaidOrder),
      purchase_event_basis: basis ?? (inputs.purchase_event_basis?.value === 1 ? "paid" : inputs.purchase_event_basis?.value === 0 ? "placed" : "unconfirmed"),
      failed_delivery: outcomes ? { share: z(outcomes.failed.value), cost_per_failure: failedCost === null ? null : m.major(m.up(failedCost)), source: outcomes.failed.provenance } : null,
    } : {}),
    maximum_viable_cpa: maximumViable === null ? null : m.major(maximumViable),
    target_cpa: target === null ? null : m.major(target),
    break_even_roas: breakEven !== null && breakEven > 0 ? ratio((v2 ? revenueFactor : paid) * point.net, breakEven) : null,
    target_roas: target !== null && target > 0 ? ratio((v2 ? revenueFactor : paid) * point.net, target) : null,
    platform_target_roas: target !== null && target > 0 ? ratio(point.charged, target) : null,
    contribution_upper_bound: ready || missing.has("PRICE_UNKNOWN") || currency === null ? null : m.major(point.contribution),
    missing: [...missing],
    notes: [...notes],
  };
}
