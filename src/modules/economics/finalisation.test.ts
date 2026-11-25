import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeProductEconomics } from "./contribution";
import { allocatePortfolio } from "./portfolio";
import { acquisitionFromCampaigns, attributionLagDays, evaluateCampaign, measureCampaign, type CampaignDay, type TrackedCampaign } from "./feedback";
import { parseEconomicsPolicy } from "./policy";
import { recommendProduct } from "./recommend";
import { refundMaturityDays } from "./repository-pure";
import { buildScenario, COMPLETE_COSTS, HEALTHY_80, type Scenario } from "./__fixtures__/scenario";
import { POLICY_V2 } from "./__fixtures__/policy-v2";

/** Phase 4 finalisation (policy version 2, migration 0056). ILLUSTRATIVE figures; each worked out beside its assertion. */
const v2 = (s: Scenario) => ({ ...buildScenario({ ...s, policy: { ...POLICY_V2.settings, ...s.policy } }) });
const economics = (s: Scenario, extra: Partial<Parameters<typeof computeProductEconomics>[0]> = {}) => computeProductEconomics({ ...v2(s), ...extra });
/** Matured order outcomes: placed, paid, shipped but never paid. */
const outcomes = (placed: number, paid: number, unpaidShipped: number) => (s: ReturnType<typeof v2>) => {
  s.product.matured = { ...s.product.matured, placed, paid, unpaid_shipped: unpaidShipped, unpaid_unshipped: placed - paid - unpaidShipped };
  return s;
};

describe("policy version 2", () => {
  it("the fixture equals version 2 as migration 0056 writes it, and it parses", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0056_economics_finalisation.sql"), "utf8");
    const insert = sql.slice(sql.indexOf("insert into public.economics_policies (version, settings, rationale, status, activated_at) values (2,"));
    const settings = JSON.parse(insert.slice(insert.indexOf("'{") + 1, insert.indexOf("}'::jsonb") + 1));
    expect(settings).toEqual(POLICY_V2.settings);
    expect(parseEconomicsPolicy(POLICY_V2)).toEqual(POLICY_V2);
    expect(() => parseEconomicsPolicy({ ...POLICY_V2, settings: { ...POLICY_V2.settings, micro_pilot_min_conversions: 9 } })).toThrow(/micro_pilot/);
    expect(() => parseEconomicsPolicy({ ...POLICY_V2, settings: { ...POLICY_V2.settings, estimate_downside_factor: undefined } })).toThrow(/estimate_downside_factor/);
  });
});

describe("1A. purchases counted when placed or when paid; failed deliveries", () => {
  // The $80 product earns $30 per paid order. Of 100 matured orders placed: 80 paid, 15 shipped but never paid
  // (cash on delivery refused), 5 cancelled before shipping. A failed delivery costs $7 shipping + $2 fulfilment
  // + $16 for the parcel's return = $25.
  const cod = (basis?: 0 | 1) => {
    const s = outcomes(100, 80, 15)(v2({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ...(basis === undefined ? {} : { purchase_event_basis: basis }) } }));
    return computeProductEconomics(s);
  };

  it("counted only when paid: break-even per paid order is $30 − (15/80) × $25 = $25.31", () => {
    expect(cod(1)).toMatchObject({ calc_version: "econ-1.1.0", purchase_event_basis: "paid", contribution: 30, break_even_cpa: 25.31,
      break_even_cpa_per_paid_order: 25.31, failed_delivery: { share: 0.15, cost_per_failure: 25, source: "observed" } });
  });

  it("counted when placed: 0.8 × $30 − 0.15 × $25 = $20.25 per purchase counted; still $25.31 per paid order", () => {
    expect(cod(0)).toMatchObject({ purchase_event_basis: "placed", break_even_cpa: 20.25, break_even_cpa_per_paid_order: 25.31 });
    expect(cod(0).notes).toContain("UNPAID_ORDERS_ADJUSTED");
  });

  it("not confirmed: the lower break-even ($20.25) is used, and said so", () => {
    const e = cod();
    expect(e).toMatchObject({ purchase_event_basis: "unconfirmed", break_even_cpa: 20.25 });
    expect(e.notes).toEqual(expect.arrayContaining(["PURCHASE_EVENT_BASIS_UNCONFIRMED", "FAILED_DELIVERIES_COUNTED"]));
  });

  it("does not reduce break-even for unpaid orders when the purchase is only counted once paid and nothing was shipped", () => {
    // 20 of 100 orders cancelled before shipping: no cost, and no purchase event under the paid basis.
    const s = outcomes(100, 80, 0)(v2({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, purchase_event_basis: 1 } }));
    expect(computeProductEconomics(s)).toMatchObject({ break_even_cpa: 30, break_even_cpa_per_paid_order: 30 });
    // Version 1 always reduced it (30 × paid share): the old record recomputes as it was.
    const v1 = buildScenario({ ...HEALTHY_80, ordersCreated: 125 });
    expect(computeProductEconomics(v1)).toMatchObject({ calc_version: "econ-1.0.0", break_even_cpa: 24 });
  });

  it("a failed delivery needs the return cost", () => {
    const { return_handling_cost: _r, ...rest } = COMPLETE_COSTS;
    void _r;
    const s = outcomes(100, 80, 15)(v2({ ...HEALTHY_80, returns: 0, inputs: rest }));
    expect(computeProductEconomics(s).missing).toContain("RETURN_COST_MISSING");
  });
});

describe("1B and 1C. confirmed zero costs; landed cost per variant", () => {
  it("a zero unit cost stays missing until the merchant confirms it for the variant or the product", () => {
    const zero: Scenario = { ...HEALTHY_80, variants: [{ price: 80, cost: 0, units: 100, available: 500 }] };
    expect(economics(zero).missing).toEqual(["UNIT_COST_ZERO"]);
    const built = v2(zero);
    const confirmed = { [built.product.variants[0].id]: { unit_cost_zero_confirmed: { key: "unit_cost_zero_confirmed" as const, value: 1, state: "merchant_entered" as const,
      scope: "product" as const, entered_at: "2026-11-24T00:00:00Z", stale: false } } };
    const e = computeProductEconomics({ ...built, variantInputs: confirmed });
    expect(e.missing).toEqual([]);
    expect(e.notes).toContain("UNIT_COST_ZERO_CONFIRMED");
    expect(e.lines.product_cost.amount).toBe(0);
    expect(economics(zero, { inputs: { ...built.inputs, unit_cost_zero_confirmed: confirmed[built.product.variants[0].id].unit_cost_zero_confirmed } }).missing).toEqual([]);
  });

  it("allocates landed cost per variant by the variant mix, once per unit", () => {
    const mixed: Scenario = { ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 60, available: 300 }, { price: 90, cost: 40, units: 40, available: 200 }] };
    const built = v2(mixed);
    const [a, b] = built.product.variants.map((v) => v.id);
    const landed = (value: number) => ({ landed_cost_per_unit: { key: "landed_cost_per_unit" as const, value, state: "merchant_entered" as const, scope: "product" as const,
      entered_at: "2026-11-24T00:00:00Z", stale: false } });
    // 0.6 × $2 + 0.4 × $3 = $2.40 a unit, one unit per order.
    const both = computeProductEconomics({ ...built, variantInputs: { [a]: landed(2), [b]: landed(3) } });
    expect(both.lines.landed_cost).toMatchObject({ amount: 2.4, basis: "per unit, by variant" });
    // One variant set, nothing for the other and no shop-wide figure: unknown, never zero.
    const { landed_cost_rate: _l, ...noRate } = COMPLETE_COSTS;
    void _l;
    const partial = v2({ ...mixed, inputs: noRate });
    expect(computeProductEconomics({ ...partial, variantInputs: { [a]: landed(2) } }).missing).toContain("LANDED_COST_UNCONFIRMED");
  });
});

describe("1D. merchant estimates carry a downside", () => {
  it("a new product on estimates: break-even $30, but maximum viable tests estimates 1.5× worse", () => {
    const fresh: Scenario = { variants: [{ price: 80, cost: 30, available: 200 }], orders: 0,
      inputs: { ...COMPLETE_COSTS, expected_discount_rate: { estimate: 0.05 }, expected_refund_rate: { estimate: 4 / 76 }, expected_return_rate: { estimate: 0.05 } } };
    const e = economics(fresh);
    expect(e).toMatchObject({ contribution: 30, break_even_cpa: 30, target_cpa: 21 });
    // Discounts 7.5% ($6), refunds 7.9% of $74 ($5.85), returns 7.5% × $16 ($1.20), fees on $74 ($2.15): contribution $25.80.
    expect(e.maximum_viable_cpa).toBe(25.8);
    expect(e.notes).toContain("ESTIMATE_DOWNSIDE_APPLIED");
    // Version 1 gave estimates no margin at all.
    expect(computeProductEconomics(buildScenario(fresh)).maximum_viable_cpa).toBe(30);
  });
});

describe("2. the diagnostic micro-pilot", () => {
  const limited = (testLimit: number) => {
    const built = v2({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ad_test_limit: testLimit, ad_max_loss: testLimit } });
    return recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: built.evidence.freshness });
  };
  it("below the 5-sale minimum ($105) but above one sale at target ($21): a labelled micro-pilot", () => {
    const r = limited(60);
    expect(r.verdict).toBe("PILOT");
    expect(r.budget).toMatchObject({ status: "recommended", kind: "micro_pilot", test_budget: 60, daily_budget: 4.28 });
    expect(r.notes).toEqual(expect.arrayContaining(["MICRO_PILOT_DIAGNOSTIC", "BUDGET_BELOW_MINIMUM_TEST"]));
  });
  it("below one sale at target: nothing", () => {
    expect(limited(15).budget).toMatchObject({ status: "zero", test_budget: 0 });
  });
  it("is funded only after every full test (found live on staging: a micro-pilot displaced a full pilot)", () => {
    const micro = limited(60);                       // $60 diagnostic, product 1
    const built = v2({ ...HEALTHY_80, productId: 2, inputs: { ...COMPLETE_COSTS, ad_test_limit: 1000, ad_max_loss: 600 } });
    const full = recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: built.evidence.freshness });   // $210 pilot
    // Product 1 sorts first by id and has the same economics; with $230 left, the full pilot still comes first.
    const a = allocatePortfolio({ currency: "USD", recommendations: [micro, full], commitments: [], monthlyLimit: 230, policy: POLICY_V2.settings });
    expect(a.allocations.map((x) => [x.product_id, x.rank, x.allocated, x.outcome])).toEqual([[2, 1, 210, "full"], [1, 2, 0, "none"]]);
    expect(a.allocations[1].rank_basis).toMatch(/^diagnostic micro-pilot, funded after full tests/);
  });
});

const days = (n: number, last: string, spend: number, conversions: number, extra: Partial<CampaignDay> = {}): CampaignDay[] =>
  Array.from({ length: n }, (_, i) => ({ day: new Date(Date.parse(`${last}T00:00:00Z`) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    spend, conversions, conversion_value: null, clicks: null, impressions: null, fx_to_shop: 1, fx_source: "same currency", ...extra }));
const campaign = (results: CampaignDay[], patch: Partial<TrackedCampaign> = {}): TrackedCampaign => ({ id: "c-1", name: "T", product_ids: [1], status: "active",
  currency: "USD", daily_budget: 34, authorised_budget: 1000, max_loss: 600, recommendation_run_id: null, started_on: "2026-10-01", last_scaled_on: null,
  purpose: "test", results, ...patch });

describe("3. campaign evidence: attribution windows, diagnostics, exchange rates, refund maturity", () => {
  const policy = POLICY_V2.settings;
  it("reads the attribution wait from the campaign's own setting", () => {
    expect([attributionLagDays("7d_click_1d_view", 7), attributionLagDays("1d_click", 7), attributionLagDays("28d_click_1d_view", 7), attributionLagDays(undefined, 7)])
      .toEqual([7, 1, 28, 7]);
    // A 1-day click window matures sooner: on 2026-11-24, days up to 2026-11-23 are judged.
    const m = measureCampaign(days(10, "2026-11-23", 10, 1), "USD", "2026-11-24T00:00:00Z", policy, undefined, 1);
    expect(m).toMatchObject({ matured_days: 10, attribution_lag_days: 1 });
  });

  it("a diagnostic micro-pilot never proves acquisition and never scales", () => {
    const great = days(20, "2026-11-17", 34, 2);
    expect(acquisitionFromCampaigns([campaign(great, { purpose: "diagnostic" })], 1, "USD", "2026-11-24T00:00:00Z", policy))
      .toMatchObject({ matured_conversions: 40, diagnostic_only: true });
    const built = v2({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ad_test_limit: 1000, ad_max_loss: 600 } });
    const acquisition = acquisitionFromCampaigns([campaign(great, { purpose: "diagnostic" })], 1, "USD", "2026-11-24T00:00:00Z", policy);
    const rec = recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: built.evidence.freshness, acquisition });
    expect(rec.verdict).toBe("PILOT");
    expect(rec.confidence.acquisition).toBe("indicative");   // never "proven", however good
    expect(rec.notes).toContain("DIAGNOSTIC_RESULTS_ONLY");
    const f = evaluateCampaign({ campaign: campaign(great, { purpose: "diagnostic" }), shopCurrency: "USD", current: [rec], policy, asOf: "2026-11-24T00:00:00Z", dailyLimit: 50 });
    expect(f).toMatchObject({ action: "CONTINUE", reasons: ["MICRO_PILOT_DIAGNOSTIC"], next_daily_budget: null });
  });

  it("keeps the ad-reported cost per sale apart from the cost per order actually paid", () => {
    // 80 of 100 matured orders paid, 15 failed deliveries. The campaign: $680 for 40 purchases counted, $17 each.
    const rec = (basis?: 0 | 1) => {
      const built = outcomes(100, 80, 15)(v2({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ad_test_limit: 1000, ad_max_loss: 600,
        ...(basis === undefined ? {} : { purchase_event_basis: basis }) } }));
      return recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: built.evidence.freshness });
    };
    const judge = (basis?: 0 | 1) => evaluateCampaign({ campaign: campaign(days(20, "2026-11-17", 34, 2)), shopCurrency: "USD", current: [rec(basis)],
      policy: POLICY_V2.settings, asOf: "2026-11-24T00:00:00Z", dailyLimit: 50 });
    // Counted when placed: 40 purchases are 32 paid orders, $21.25 each, against $25.31 per paid order.
    expect(judge(0)).toMatchObject({ break_even_cpa: 20.25, measure: { cpa: 17 },
      paid_orders: { purchase_event_basis: "placed", cpa_per_paid_order: 21.25, break_even_cpa_per_paid_order: 25.31 } });
    expect(judge(1).paid_orders).toEqual({ purchase_event_basis: "paid", cpa_per_paid_order: 17, break_even_cpa_per_paid_order: 25.31 });
    expect(judge().paid_orders).toEqual({ purchase_event_basis: "unconfirmed", cpa_per_paid_order: null, break_even_cpa_per_paid_order: 25.31 });
    // Version 1 recommendations carry no paid-order view.
    expect(evaluateCampaign({ campaign: campaign(days(20, "2026-11-17", 34, 2)), shopCurrency: "USD",
      current: [recommendProduct({ ...buildScenario(HEALTHY_80), asOf: "2026-11-24T00:00:00Z", freshness: buildScenario(HEALTHY_80).evidence.freshness })],
      policy: buildScenario(HEALTHY_80).policy, asOf: "2026-11-24T00:00:00Z" }).paid_orders).toBeUndefined();
  });

  it("lists each exchange rate with its pair and when it applied", () => {
    const m = measureCampaign(days(5, "2026-11-10", 20, 1, { fx_to_shop: 1550, fx_source: "exchange_rate_cache", fx_from: "USD", fx_to: "NGN", fx_as_of: "2026-11-01T06:00:00Z" }),
      "NGN", "2026-11-24T00:00:00Z", policy);
    expect(m.fx).toEqual([{ rate: 1550, source: "exchange_rate_cache", days: 5, from: "USD", to: "NGN", as_of: "2026-11-01T06:00:00Z" }]);
  });

  it("sets refund maturity from the store's own refund timing once there are enough refunds", () => {
    expect(refundMaturityDays(policy, { refunds: 50, p90_days: 41.2 })).toBe(42);
    expect(refundMaturityDays(policy, { refunds: 50, p90_days: 9 })).toBe(30);      // never below 30
    expect(refundMaturityDays(policy, { refunds: 50, p90_days: 300 })).toBe(120);   // never above 120
    expect(refundMaturityDays(policy, { refunds: 5, p90_days: 41 })).toBe(60);      // too few: the default
    expect(refundMaturityDays(buildScenario(HEALTHY_80).policy, { refunds: 500, p90_days: 41 })).toBe(60); // version 1: unchanged
  });
});
