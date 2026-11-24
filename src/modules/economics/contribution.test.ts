import { describe, expect, it } from "vitest";
import { computeProductEconomics, COST_LINES } from "./contribution";
import { buildScenario, COMPLETE_COSTS, HEALTHY_80, type Scenario } from "./__fixtures__/scenario";

/** Phase 4, task 4: contribution per acquired order. ILLUSTRATIVE figures throughout. */
const economics = (s: Scenario) => computeProductEconomics(buildScenario(s));
const amounts = (e: ReturnType<typeof economics>) => Object.fromEntries(Object.entries(e.lines).map(([k, l]) => [k, l.amount]));

describe("contribution per acquired order: the illustrative $80 product", () => {
  const e = economics(HEALTHY_80);

  it("reproduces $80 price → $72 net revenue → $30 contribution, line by line", () => {
    expect(amounts(e)).toEqual({
      gross_revenue: 80, discounts: 4, refunds: 4, tax_included: 0, shipping_revenue: 0, net_revenue: 72,
      product_cost: 30, landed_cost: 0, shipping_cost: 7, fulfilment_cost: 2, payment_fees: 2.2, selling_fees: 0, return_handling: 0.8,
      variable_costs: 42, contribution: 30,
    });
    expect(e).toMatchObject({ net_revenue: 72, variable_costs: 42, contribution: 30, contribution_margin: 0.4167, charged_per_order: 76, missing: [] });
  });

  it("derives break-even $30, target $21 at the 30% reserve, and both ROAS figures", () => {
    expect(e).toMatchObject({ break_even_cpa: 30, target_cpa: 21, break_even_roas: 2.4, target_roas: 3.4286, platform_target_roas: 3.619 });
    // Maximum viable CPA: refunds and returns at their 90% upper bounds (5 of 100 orders → 8.59%), paid share at its lower bound.
    expect(e.maximum_viable_cpa).toBe(26.11);
    expect(e.target_cpa! <= e.maximum_viable_cpa! && e.maximum_viable_cpa! <= e.break_even_cpa!).toBe(true);
  });

  it("records where every figure came from", () => {
    expect(e.rates.discount).toMatchObject({ provenance: "observed", sample: 100 });
    expect(e.rates.refund).toMatchObject({ provenance: "observed", sample: 100 });
    expect(e.lines.product_cost.provenance).toBe("observed");
    expect(e.lines.shipping_cost.provenance).toBe("merchant_entered");
    expect(e.lines.selling_fees.provenance).toBe("confirmed_none");
    expect(e.notes).toEqual([]);
  });

  it("a different reserve moves only the target", () => {
    const r20 = economics({ ...HEALTHY_80, policy: { contribution_reserve: 0.2 } });
    expect(r20).toMatchObject({ break_even_cpa: 30, target_cpa: 24 });
    // A reserve too small to matter: the maximum viable CPA caps the target.
    expect(economics({ ...HEALTHY_80, policy: { contribution_reserve: 0 } }).target_cpa).toBe(26.11);
  });
});

describe("missing and unreliable inputs never become numbers", () => {
  it("a missing unit cost gives no contribution, only an upper bound from what is known", () => {
    const e = economics({ ...HEALTHY_80, variants: [{ price: 80, cost: null, units: 100 }] });
    expect(e.missing).toEqual(["UNIT_COST_MISSING"]);
    expect(e).toMatchObject({ contribution: null, break_even_cpa: null, target_cpa: null, net_revenue: null });
    expect(e.lines.product_cost.amount).toBeNull();
    // Known revenue $72 − known costs $12 (no product cost): $60 is the most contribution could be.
    expect(e.contribution_upper_bound).toBe(60);
  });

  it("names each missing or unreliable input", () => {
    expect(economics({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 60 }, { price: 90, cost: null, units: 40 }] }).missing).toEqual(["UNIT_COST_PARTIAL"]);
    expect(economics({ ...HEALTHY_80, variants: [{ price: 80, cost: 0, units: 100 }] }).missing).toEqual(["UNIT_COST_ZERO"]);
    expect(economics({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, costCurrency: "EUR" }] }).missing).toEqual(["UNIT_COST_CURRENCY_MISMATCH"]);
    const noInputs = economics({ ...HEALTHY_80, inputs: {} });
    expect(noInputs.missing.sort()).toEqual(["FULFILMENT_COST_MISSING", "LANDED_COST_UNCONFIRMED", "PAYMENT_FEES_MISSING", "RETURN_COST_MISSING",
      "SELLING_FEES_UNCONFIRMED", "SHIPPING_COST_MISSING"]);
    expect(noInputs.contribution).toBeNull();
    expect(economics({ ...HEALTHY_80, currency: null }).missing).toContain("SHOP_CURRENCY_UNKNOWN");
    expect(economics({ ...HEALTHY_80, variants: [{ price: 0, cost: 30, units: 100 }] }).missing).toContain("PRICE_UNKNOWN");
  });

  it("a product without history needs store or merchant rates, and says which it used", () => {
    const fresh: Scenario = { variants: [{ price: 80, cost: 30 }], orders: 0, inputs: COMPLETE_COSTS };
    expect(economics(fresh).missing.sort()).toEqual(["DISCOUNT_RATE_UNKNOWN", "RETURN_RATE_UNVERIFIED"]);
    const withEstimates = economics({ ...fresh, inputs: { ...COMPLETE_COSTS, expected_discount_rate: { estimate: 0.05 },
      expected_refund_rate: { estimate: 4 / 76 }, expected_return_rate: { estimate: 0.05 } } });
    expect(withEstimates.missing).toEqual([]);
    expect(withEstimates.notes).toEqual(expect.arrayContaining(["NO_SALES_HISTORY", "SINGLE_UNIT_ASSUMED", "DISCOUNT_RATE_MERCHANT_ESTIMATE",
      "RETURN_RATE_MERCHANT_ESTIMATE", "UNPAID_SHARE_UNOBSERVED"]));
    expect(withEstimates.rates.refund.provenance).toBe("merchant_estimate");
    // The same economics as the observed product, except no history to bound: maximum viable equals break-even.
    expect(withEstimates).toMatchObject({ contribution: 30, break_even_cpa: 30, maximum_viable_cpa: 30, target_cpa: 21 });
    const withStore = economics({ ...fresh, store: { discount_orders: 200, discount_gross: 10_000, discount_amount: 500, matured_orders: 150,
      matured_total: 12_000, matured_refunded: 600, matured_orders_returned: 6, orders: 300, orders_unpaid: 0 } });
    expect(withStore.missing).toEqual([]);
    expect(withStore.notes).toEqual(expect.arrayContaining(["DISCOUNT_RATE_STORE_PROXY", "RETURN_RATE_STORE_PROXY"]));
    expect(withStore.rates.discount).toMatchObject({ provenance: "store_proxy", value: 0.05 });
  });

  it("a missing return handling cost matters only when returns happen", () => {
    const { return_handling_cost: _unused, ...rest } = COMPLETE_COSTS;
    void _unused;
    expect(economics({ ...HEALTHY_80, inputs: rest }).missing).toEqual(["RETURN_COST_MISSING"]);
    expect(economics({ ...HEALTHY_80, returns: 0, inputs: rest }).missing).toEqual([]);
  });

  it("prices that include tax need a tax rate; none seen means unknown", () => {
    expect(economics({ variants: [{ price: 80, cost: 30 }], orders: 0, taxesIncluded: true, inputs: COMPLETE_COSTS }).missing).toContain("TAX_RATE_UNKNOWN");
  });
});

describe("each component, counted once", () => {
  it("negative contribution: variable costs above net revenue", () => {
    const e = economics({ ...HEALTHY_80, variants: [{ price: 80, cost: 70, units: 100 }] });
    expect(e.contribution).toBe(-10);
    expect(e).toMatchObject({ break_even_cpa: 0, target_cpa: 0, maximum_viable_cpa: 0, break_even_roas: null, target_roas: null });
  });

  it("removes tax inside prices from revenue, and charges payment fees on tax charged on top", () => {
    const inside = economics({ ...HEALTHY_80, taxesIncluded: true, taxShare: 1 / 6 });
    // (76 − 4) × 1/6 = 12 of tax inside the prices.
    expect(inside.lines.tax_included.amount).toBe(12);
    expect(inside.net_revenue).toBe(60);
    const onTop = economics({ ...HEALTHY_80, taxesIncluded: false, taxShare: 0.2 });
    expect(onTop.lines.tax_included.amount).toBe(0);
    expect(onTop.net_revenue).toBe(72);
    expect(onTop.charged_per_order).toBe(91.2);
    expect(onTop.lines.payment_fees.amount).toBe(2.58); // 2.5% × 91.20 + 0.30
  });

  it("counts customer-paid shipping as revenue and the merchant's shipping as a cost, once each", () => {
    const e = economics({ ...HEALTHY_80, shippingPerOrder: 5 });
    expect(e.lines.shipping_revenue.amount).toBe(5);
    expect(e.lines.shipping_cost.amount).toBe(7);
    expect(e.contribution).toBe(30 + 5 - 0.13); // +£5 revenue, and 2.5% fees on it (0.125, rounded up)
  });

  it("restocked refunds recover product cost; refunds reduce revenue once, never as a cost", () => {
    const none = economics(HEALTHY_80);
    const restocked = economics({ ...HEALTHY_80, restockedUnits: 5 });
    expect(restocked.lines.refunds.amount).toBe(none.lines.refunds.amount);
    expect(restocked.lines.product_cost.amount).toBe(28.5); // 30 × (1 − 5/100)
    for (const key of COST_LINES) expect(restocked.lines[key].basis).not.toMatch(/refund amount/);
  });

  it("measures acquisition cost per order placed when some orders are never paid", () => {
    const e = economics({ ...HEALTHY_80, ordersCreated: 125 });
    expect(e.rates.paid_share.value).toBe(0.8);
    expect(e.notes).toContain("UNPAID_ORDERS_ADJUSTED");
    expect(e.break_even_cpa).toBe(24); // $30 per paid order × 80% of orders paid
    expect(e.target_cpa).toBe(16.8);
  });
});

/** A small seeded generator: property tests stay deterministic. */
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, pick: (lo: number, hi: number) => Math.round((lo + next() * (hi - lo)) * 100) / 100, int: (lo: number, hi: number) => Math.floor(lo + next() * (hi - lo + 1)) };
}
function randomScenario(g: ReturnType<typeof generator>): Scenario {
  const orders = g.int(20, 400);
  const refunded = g.int(0, Math.floor(orders / 5));
  return {
    variants: [{ price: g.pick(5, 400), cost: g.pick(1, 200), units: orders * g.int(1, 3), available: g.int(0, 900) }],
    orders, discountRate: g.pick(0, 0.3), refundRate: g.pick(0, 0.3), refundedOrders: refunded, returns: g.int(0, refunded),
    restockedUnits: g.int(0, refunded), shippingPerOrder: g.pick(0, 15), taxShare: g.pick(0, 0.25), taxesIncluded: g.next() < 0.5,
    inputs: { payment_rate: g.pick(0, 0.05), payment_fixed_fee: g.pick(0, 1), selling_fee_rate: g.pick(0, 0.1), shipping_cost_per_order: g.pick(0, 20),
      fulfilment_cost_per_order: g.pick(0, 5), fulfilment_cost_per_unit: g.pick(0, 2), landed_cost_rate: g.pick(0, 0.3), return_handling_cost: g.pick(0, 25) },
  };
}

describe("properties over 500 random products", () => {
  const g = generator(20261124);
  const scenarios = Array.from({ length: 500 }, () => randomScenario(g));

  it("the lines add up exactly, and target ≤ maximum viable ≤ break-even", () => {
    for (const s of scenarios) {
      const e = economics(s);
      expect(e.missing).toEqual([]);
      const l = e.lines;
      const cents = (x: number | null) => Math.round((x ?? 0) * 100);
      expect(cents(l.net_revenue.amount)).toBe(cents(l.gross_revenue.amount) - cents(l.discounts.amount) - cents(l.refunds.amount) - cents(l.tax_included.amount) + cents(l.shipping_revenue.amount));
      expect(cents(l.variable_costs.amount)).toBe(COST_LINES.reduce((t, k) => t + cents(l[k].amount), 0));
      expect(cents(e.contribution)).toBe(cents(e.net_revenue) - cents(e.variable_costs));
      expect(e.target_cpa!).toBeLessThanOrEqual(e.maximum_viable_cpa!);
      expect(e.maximum_viable_cpa!).toBeLessThanOrEqual(e.break_even_cpa!);
      // Rounding never raises a ceiling: break-even never exceeds the contribution.
      expect(e.break_even_cpa!).toBeLessThanOrEqual(Math.max(0, e.contribution!));
      if (e.contribution! <= 0) expect([e.break_even_cpa, e.target_cpa]).toEqual([0, 0]);
    }
  });

  it("contribution never rises when any cost, rate or reduction rises", () => {
    const bumps: Array<[string, (s: Scenario) => Scenario]> = [
      ["unit cost", (s) => ({ ...s, variants: s.variants.map((v) => ({ ...v, cost: (v.cost ?? 0) + 3 })) })],
      ["discount rate", (s) => ({ ...s, discountRate: Math.min(0.99, (s.discountRate ?? 0) + 0.05) })],
      ["refund rate", (s) => ({ ...s, refundRate: Math.min(0.99, (s.refundRate ?? 0) + 0.05) })],
      ["fewer restocks", (s) => ({ ...s, restockedUnits: 0 })],
      ["more returns", (s) => ({ ...s, returns: (s.returns ?? 0) + 2, refundedOrders: (s.refundedOrders ?? 0) + 2 })],
      ...(["payment_rate", "payment_fixed_fee", "selling_fee_rate", "shipping_cost_per_order", "fulfilment_cost_per_order", "fulfilment_cost_per_unit",
        "landed_cost_rate", "return_handling_cost"] as const).map((key): [string, (s: Scenario) => Scenario] =>
        [key, (s) => ({ ...s, inputs: { ...s.inputs, [key]: Number(s.inputs?.[key] ?? 0) + (key.endsWith("rate") ? 0.01 : 1) } })]),
    ];
    for (const s of scenarios.slice(0, 200)) {
      const base = economics(s).contribution!;
      for (const [name, bump] of bumps) expect(economics(bump(s)).contribution!, name).toBeLessThanOrEqual(base + 1e-9);
    }
  });

  it("a refund changes revenue, never the product cost; a restock changes product cost, never revenue", () => {
    for (const s of scenarios.slice(0, 200)) {
      const base = economics(s);
      const moreRefunds = economics({ ...s, refundRate: Math.min(0.99, (s.refundRate ?? 0) + 0.1) });
      expect(moreRefunds.lines.product_cost.amount).toBe(base.lines.product_cost.amount);
      const moreRestocks = economics({ ...s, restockedUnits: (s.restockedUnits ?? 0) + 1 });
      expect(moreRestocks.lines.net_revenue.amount).toBe(base.lines.net_revenue.amount);
    }
  });
});
