import { describe, expect, it } from "vitest";
import { acquisitionFromCampaigns, commitmentsFromCampaigns, evaluateCampaign, measureCampaign, type CampaignDay, type TrackedCampaign } from "./feedback";
import { allocatePortfolio } from "./portfolio";
import { recommendProduct } from "./recommend";
import { poissonBounds } from "./stats";
import { buildScenario, HEALTHY_80, type Scenario } from "./__fixtures__/scenario";

/**
 * Phase 4, task 7: what to do after advertising begins. ILLUSTRATIVE campaigns for the $80 product
 * (break-even $30, target $21). As of 2026-11-24 with a 7-day attribution lag, days up to 2026-11-17 are matured.
 */
const AS_OF = "2026-11-24T00:00:00Z";
const policy = buildScenario(HEALTHY_80).policy;
const current = (s: Scenario = HEALTHY_80) => {
  const built = buildScenario({ ...s, inputs: { ...s.inputs, ad_test_limit: 1000, ad_max_loss: 600 } });
  return recommendProduct({ ...built, asOf: AS_OF, freshness: built.evidence.freshness });
};
/** n days ending on `last`, each with the same spend and conversions. */
const days = (n: number, last: string, spend: number, conversions: number, extra: Partial<CampaignDay> = {}): CampaignDay[] =>
  Array.from({ length: n }, (_, i) => ({ day: new Date(Date.parse(`${last}T00:00:00Z`) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    spend, conversions, conversion_value: conversions * 80, clicks: null, impressions: null, fx_to_shop: 1, fx_source: "same currency", ...extra }));
const campaign = (results: CampaignDay[], patch: Partial<TrackedCampaign> = {}): TrackedCampaign => ({ id: "c-1", name: "Test", product_ids: [1], status: "active",
  currency: "USD", daily_budget: 34, authorised_budget: 1000, max_loss: 600, recommendation_run_id: null, started_on: "2026-10-01", last_scaled_on: null, results, ...patch });
const evaluate = (c: TrackedCampaign, extra: Partial<Parameters<typeof evaluateCampaign>[0]> = {}) =>
  evaluateCampaign({ campaign: c, shopCurrency: "USD", current: [current()], policy, asOf: AS_OF, dailyLimit: 50, ...extra });

describe("measuring a campaign", () => {
  it("judges matured days only, with an exact Poisson interval on the cost per sale", () => {
    // 20 matured days of $34 and 2 sales, then 5 immature days.
    const m = measureCampaign([...days(20, "2026-11-17", 34, 2), ...days(5, "2026-11-22", 34, 1)], "USD", AS_OF, policy);
    expect(m).toMatchObject({ days: 25, matured_days: 20, immature_days: 5, spend: 850, matured_spend: 680, matured_conversions: 40, cpa: 17 });
    const b = poissonBounds(40, 0.9);
    expect(m.cpa_lower).toBe(Math.floor((680 / b.upper) * 100) / 100);
    expect(m.cpa_upper).toBe(Math.ceil((680 / b.lower) * 100) / 100);
    expect(m.cpa_upper!).toBeLessThan(30);
  });

  it("keeps the conversion rate's own Wilson interval apart from the CPA interval", () => {
    const m = measureCampaign(days(20, "2026-11-17", 34, 2, { clicks: 40 }), "USD", AS_OF, policy);
    expect(m.conversion_rate).toMatchObject({ value: 0.05, clicks: 800 });
    // The two intervals answer different questions: the rate's relative width is not the CPA's.
    const rateWidth = (m.conversion_rate!.upper - m.conversion_rate!.lower) / m.conversion_rate!.value;
    const cpaWidth = (m.cpa_upper! - m.cpa_lower!) / m.cpa!;
    expect(Math.abs(rateWidth - cpaWidth)).toBeGreaterThan(0.01);
  });

  it("converts each day at the rate recorded beside it, and lists the rates used", () => {
    const m = measureCampaign(days(10, "2026-11-10", 20, 1, { fx_to_shop: 1500, fx_source: "exchange_rate_cache 2026-11-01" }), "NGN", AS_OF, policy);
    expect(m).toMatchObject({ currency: "NGN", matured_spend: 300_000, cpa: 30_000 });
    expect(m.fx).toEqual([{ rate: 1500, source: "exchange_rate_cache 2026-11-01", days: 10 }]);
  });
});

describe("what to do next", () => {
  it("does nothing for a campaign that is not running", () => {
    expect(evaluate(campaign(days(5, "2026-11-10", 30, 1), { status: "paused" })).action).toBe("NOT_RUNNING");
  });

  it("STOP: the authorised loss is reached ($300 spent, 3 sales × $30 = $90 back, loss $210 ≥ $200)", () => {
    const f = evaluate(campaign(days(10, "2026-11-10", 30, 0).map((d, i) => ({ ...d, conversions: i < 3 ? 1 : 0 })), { max_loss: 200 }));
    expect(f).toMatchObject({ action: "STOP", reasons: ["LOSS_LIMIT_REACHED"], cumulative_loss: 210, next_daily_budget: 0 });
  });

  it("PAUSE: the product no longer pays for itself", () => {
    const f = evaluate(campaign(days(10, "2026-11-10", 30, 1)), { current: [current({ ...HEALTHY_80, variants: [{ price: 80, cost: 70, units: 100, available: 500 }] })] });
    expect(f).toMatchObject({ action: "PAUSE_REVISE", reasons: ["NEGATIVE_CONTRIBUTION_MARGIN"], next_daily_budget: 0 });
  });

  it("RECALCULATE: the price moved 12.5% since the campaign was authorised", () => {
    const f = evaluate(campaign(days(10, "2026-11-10", 30, 1)), {
      atLaunch: [current()], current: [current({ ...HEALTHY_80, variants: [{ price: 90, cost: 30, units: 100, available: 500 }] })] });
    expect(f).toMatchObject({ action: "RECALCULATE", reasons: ["ECONOMICS_CHANGED"], next_daily_budget: null });
  });

  it("PAUSE or REDUCE for stock: nothing left, or too little for a week at the current budget", () => {
    const empty = evaluate(campaign(days(3, "2026-11-22", 50, 0)), { current: [current({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, available: 8 }] })] });
    expect(empty).toMatchObject({ action: "PAUSE_FOR_INVENTORY", next_daily_budget: 0 });
    // 12 units for ads; $50 a day at the $21 target brings ~16.7 orders a week: reduce to 12 × $21 ÷ 7 = $36.
    const low = evaluate(campaign(days(3, "2026-11-22", 50, 0), { daily_budget: 50 }),
      { current: [current({ ...HEALTHY_80, variants: [{ price: 80, cost: 30, units: 100, available: 20 }] })] });
    expect(low).toMatchObject({ action: "REDUCE_FOR_INVENTORY", reasons: ["INVENTORY_LIMITED"], next_daily_budget: 36 });
  });

  it("judges a running campaign's stock correctly even though its product gets no second budget (found live, task 9)", () => {
    const built = buildScenario({ ...HEALTHY_80, inputs: { ...HEALTHY_80.inputs, ad_test_limit: 1000, ad_max_loss: 600 } });
    const funded = recommendProduct({ ...built, asOf: AS_OF, freshness: built.evidence.freshness, alreadyFunded: true });
    expect(funded.budget).toMatchObject({ status: "zero", test_budget: 0, inventory: { sellable_units: 500, units_for_ads: 492 } });
    expect(evaluate(campaign(days(20, "2026-11-17", 34, 2)), { current: [funded] }).action).toBe("SCALE");
  });

  it("WAIT: no matured day yet, or matured spend still under one break-even", () => {
    expect(evaluate(campaign(days(5, "2026-11-23", 30, 1)))).toMatchObject({ action: "WAIT", reasons: ["ATTRIBUTION_IMMATURE"], next_daily_budget: null });
    expect(evaluate(campaign([...days(2, "2026-11-17", 10, 0), ...days(3, "2026-11-23", 10, 0)])))
      .toMatchObject({ action: "WAIT", reasons: ["INSUFFICIENT_CONVERSION_EVIDENCE", "ATTRIBUTION_IMMATURE"] });
  });

  it("PAUSE with no sales once even the lowest plausible cost per sale is above break-even", () => {
    // Zero sales: at 90%, the count could be as high as 2.3026, so the lowest plausible CPA is spend ÷ 2.3026.
    const paused = evaluate(campaign(days(5, "2026-11-17", 15, 0)));     // $75 ÷ 2.3026 = $32.57 > $30
    expect(paused).toMatchObject({ action: "PAUSE_REVISE", reasons: ["CPA_ABOVE_BREAK_EVEN"], next_daily_budget: 0 });
    expect(paused.measure.cpa_lower).toBe(32.57);
    const notYet = evaluate(campaign(days(4, "2026-11-17", 15, 0)));     // $60 ÷ 2.3026 = $26.05 < $30
    expect(notYet.action).toBe("HOLD_OPTIMISE");
  });

  it("SCALE by at most 20%, only on matured evidence clearly inside break-even", () => {
    // 40 matured sales for $680: CPA $17 ≤ $21; upper bound under $30.
    const results = days(20, "2026-11-17", 34, 2);
    expect(evaluate(campaign(results))).toMatchObject({ action: "SCALE", next_daily_budget: 40.8 });
    expect(evaluate(campaign(results, { last_scaled_on: "2026-11-22" }))).toMatchObject({ action: "CONTINUE", reasons: ["SCALE_INTERVAL_NOT_ELAPSED"] });
    expect(evaluate(campaign(results), { dailyLimit: 34 })).toMatchObject({ action: "CONTINUE", reasons: ["MERCHANT_LIMIT_BINDING"] });
  });

  it("HOLD above target, CONTINUE on target without enough sales to scale", () => {
    // 30 sales for $750: CPA $25, between the $21 target and $30 break-even.
    expect(evaluate(campaign(days(15, "2026-11-17", 50, 2)))).toMatchObject({ action: "HOLD_OPTIMISE", reasons: ["CPA_ABOVE_TARGET"], next_daily_budget: null });
    // 12 sales for $204: CPA $17, upper bound under $30, but 12 < 20 to scale.
    const onTrack = evaluate(campaign(days(12, "2026-11-17", 17, 1)));
    expect(onTrack).toMatchObject({ action: "CONTINUE", reasons: ["INSUFFICIENT_CONVERSION_EVIDENCE"] });
  });
});

describe("campaigns as evidence and commitments", () => {
  it("only single-product campaigns count as a product's acquisition evidence", () => {
    const single = campaign(days(20, "2026-11-17", 34, 2));
    const shared = campaign(days(20, "2026-11-17", 34, 5), { id: "c-2", product_ids: [1, 2] });
    expect(acquisitionFromCampaigns([single, shared], 1, "USD", AS_OF, policy)).toMatchObject({ matured_conversions: 40, matured_spend: 680, cpa: 17, immature_days: 0 });
    expect(acquisitionFromCampaigns([shared], 1, "USD", AS_OF, policy)).toBeNull();
  });

  it("commits what a running campaign will still spend, and blocks allocation when it cannot be valued", () => {
    const running = campaign(days(10, "2026-11-20", 20, 1), { daily_budget: 20, authorised_budget: 500 });
    expect(commitmentsFromCampaigns([running], "USD", policy)).toEqual([{ campaign_id: "c-1", product_ids: [1], amount: 300 }]);
    const foreign = campaign([], { id: "c-9", product_ids: [2], currency: "EUR", daily_budget: 20, authorised_budget: null });
    const commitments = commitmentsFromCampaigns([foreign], "USD", policy);
    expect(commitments[0].amount).toBeNull();
    const allocation = allocatePortfolio({ currency: "USD", recommendations: [current()], commitments, monthlyLimit: 5000, policy });
    expect(allocation).toMatchObject({ unknown_commitments: true, available: 0, allocated: 0 });
    expect(allocation.allocations[0]).toMatchObject({ outcome: "none", reason: "COMMITMENTS_UNKNOWN" });
  });
});
