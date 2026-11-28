import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeBriefEconomics } from "@/lib/brief-economics";
import { acquisitionFromCampaigns, evaluateCampaign, measureCampaign, type CampaignDay, type TrackedCampaign } from "./feedback";
import { parseEconomicsPolicy } from "./policy";
import { normaliseReconciliationEvidence, type ReconciliationEvidence } from "./reconciliation";
import { recommendProduct } from "./recommend";
import { toBriefEconomics } from "./snapshot";
import { buildScenario, COMPLETE_COSTS, HEALTHY_80, type Scenario } from "./__fixtures__/scenario";
import { POLICY_V2 } from "./__fixtures__/policy-v2";
import { POLICY_V3 } from "./__fixtures__/policy-v3";

/**
 * Policy version 3 (migration 0057, a DRAFT pending the scaling-confidence decision): separate scaling and pausing
 * confidence, all three spending limits required, refund maturity never under 60 days. ILLUSTRATIVE $80 product:
 * break-even $30, target $21. As of 2026-11-24 with a 7-day wait, days up to 2026-11-17 are matured.
 */
const AS_OF = "2026-11-24T00:00:00Z";
const days = (n: number, last: string, spend: number, conversions: number): CampaignDay[] =>
  Array.from({ length: n }, (_, i) => ({ day: new Date(Date.parse(`${last}T00:00:00Z`) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    spend, conversions, conversion_value: null, clicks: null, impressions: null, fx_to_shop: 1, fx_source: "same currency" }));
const campaign = (results: CampaignDay[]): TrackedCampaign => ({ id: "c-1", name: "T", product_ids: [1], status: "active", currency: "USD",
  daily_budget: results[0]?.spend ?? 20, authorised_budget: 5000, max_loss: null, recommendation_run_id: null, started_on: "2026-10-01",
  last_scaled_on: null, purpose: "test", results });
const LIMITS = { ad_test_limit: 1000, ad_max_loss: 600, ad_daily_limit: 50, ad_monthly_limit: 3000 };
const rec = (policy: typeof POLICY_V3.settings, inputs: Scenario["inputs"] = { ...COMPLETE_COSTS, ...LIMITS }) => {
  const built = buildScenario({ ...HEALTHY_80, inputs, policy });
  return recommendProduct({ ...built, asOf: AS_OF, freshness: built.evidence.freshness });
};
/** Shopify's orders over the campaign's period: enough that Meta's count reconciles, synced at the check. */
const evidence = (patch: Partial<ReconciliationEvidence> = {}): ReconciliationEvidence => ({ from: "2026-09-30T00:00:00Z", to: AS_OF, timezone: "UTC",
  placed: 1000, paid: 1000, capi_sent: 0, capi_connected: false, orders_fresh_at: AS_OF, review: null, ...patch });
/** Judged on 2026-11-24 with results entered through 2026-11-23 (the days after the matured ones carry no spend). */
const judge = (results: CampaignDay[], policy: typeof POLICY_V3.settings, reconciliation: ReconciliationEvidence | null = evidence(), extra = {}) =>
  evaluateCampaign({ campaign: { ...campaign([...results, ...days(6, "2026-11-23", 0, 0)]), daily_budget: results[0]?.spend ?? 20, ...extra },
    shopCurrency: "USD", current: [rec(policy)], policy, asOf: AS_OF, dailyLimit: 1000, reconciliation });

describe("policy version 3", () => {
  it("the fixture equals the draft migration 0057 writes, and it parses; its keys come together, on top of version 2's", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0057_economics_policy_v3_draft.sql"), "utf8");
    const insert = sql.slice(sql.indexOf("insert into public.economics_policies (version, settings, rationale, status) values (3,"));
    expect(JSON.parse(insert.slice(insert.indexOf("'{") + 1, insert.indexOf("}'::jsonb") + 1))).toEqual(POLICY_V3.settings);
    expect(insert).toMatch(/'draft'\)\non conflict/);
    expect(parseEconomicsPolicy(POLICY_V3)).toEqual(POLICY_V3);
    const without = (k: keyof typeof POLICY_V3.settings) => { const s = { ...POLICY_V3.settings }; delete s[k]; return { ...POLICY_V3, settings: s }; };
    expect(() => parseEconomicsPolicy(without("pause_confidence"))).toThrow(/pause_confidence/);
    expect(() => parseEconomicsPolicy(without("estimate_downside_factor"))).toThrow();
    expect(() => parseEconomicsPolicy({ ...POLICY_V3, settings: { ...POLICY_V3.settings, scale_confidence: 1 } })).toThrow(/scale_confidence/);
  });

  it("records econ-1.2.0, and leaves the contribution and break-even exactly as version 2", () => {
    const [two, three] = [rec(POLICY_V2.settings), rec(POLICY_V3.settings)];
    expect([two.economics.calc_version, three.economics.calc_version]).toEqual(["econ-1.1.0", "econ-1.2.0"]);
    const { calc_version: _a, ...e2 } = two.economics;
    const { calc_version: _b, ...e3 } = three.economics;
    void _a; void _b;
    expect(e3).toEqual(e2);
  });
});

describe("separate confidence for scaling (97.5%) and pausing (95%)", () => {
  it("measures each bound at its own confidence: with no sales, the lowest plausible CPA is spend ÷ 3.00 (was ÷ 2.30)", () => {
    const none = days(5, "2026-11-17", 15, 0);                      // $75 matured, no sale
    const v2 = measureCampaign(none, "USD", AS_OF, POLICY_V2.settings);
    const v3 = measureCampaign(none, "USD", AS_OF, POLICY_V3.settings);
    expect([v2.cpa_lower, v3.cpa_lower]).toEqual([32.57, 25.03]);   // 75 ÷ 2.3026, 75 ÷ 2.9957
    expect(v3.confidence).toEqual({ pause: 0.95, scale: 0.975 });
    expect(v2.confidence).toBeUndefined();
  });

  it("pauses a campaign without sales only once spend passes 3 × break-even", () => {
    expect(judge(days(5, "2026-11-17", 15, 0), POLICY_V2.settings).action).toBe("PAUSE_REVISE");   // $75 > 2.30 × $30
    expect(judge(days(5, "2026-11-17", 15, 0), POLICY_V3.settings).action).toBe("HOLD_OPTIMISE");  // $75 < 3.00 × $30
    expect(judge(days(7, "2026-11-17", 15, 0), POLICY_V3.settings)).toMatchObject({ action: "PAUSE_REVISE", reasons: ["CPA_ABOVE_BREAK_EVEN"] }); // $105
  });

  it("scales on 20 sales only well under target: 20 sales at $19 scale under version 2, not under version 3", () => {
    const twenty = days(20, "2026-11-17", 19, 1);                   // 20 matured sales for $380: CPA $19
    expect(judge(twenty, POLICY_V2.settings)).toMatchObject({ action: "SCALE", measure: { cpa: 19, cpa_upper: 26.17 } });
    expect(judge(twenty, POLICY_V3.settings)).toMatchObject({ action: "HOLD_OPTIMISE", reasons: ["INSUFFICIENT_CONVERSION_EVIDENCE"], measure: { cpa_upper: 31.11 } });
    // 40 sales at $19: the 97.5% bound ($26.59) is under break-even, so version 3 scales too.
    expect(judge(days(20, "2026-11-17", 38, 2), POLICY_V3.settings)).toMatchObject({ action: "SCALE", measure: { cpa: 19 } });
  });

  it("applies the same bounds to a product's GO verdict", () => {
    const acquisition = (policy: typeof POLICY_V3.settings) => acquisitionFromCampaigns([campaign(days(20, "2026-11-17", 19, 1))], 1, "USD", AS_OF, policy);
    const go = (policy: typeof POLICY_V3.settings) => {
      const built = buildScenario({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ...LIMITS }, policy });
      return recommendProduct({ ...built, asOf: AS_OF, freshness: built.evidence.freshness, acquisition: acquisition(policy) }).verdict;
    };
    expect([go(POLICY_V2.settings), go(POLICY_V3.settings)]).toEqual(["GO", "PILOT"]);
  });
});

describe("spending authority: a test, a daily and a monthly limit", () => {
  it("shows the economics but no amount until all three are set, and names what is missing", () => {
    const { ad_daily_limit: _d, ad_monthly_limit: _m, ...testOnly } = LIMITS;
    void _d; void _m;
    const partial = rec(POLICY_V3.settings, { ...COMPLETE_COSTS, ...testOnly });
    expect(partial.budget).toMatchObject({ status: "awaiting_authority", test_budget: null, daily_budget: null });
    expect(partial.notes).toEqual(expect.arrayContaining(["MERCHANT_AUTHORITY_MISSING", "DAILY_LIMIT_MISSING", "MONTHLY_LIMIT_MISSING"]));
    expect(partial.economics).toMatchObject({ break_even_cpa: 30, target_cpa: 21 });
    const text = describeBriefEconomics(toBriefEconomics(partial, { runId: "r", policyVersion: 3, computedAt: AS_OF }));
    expect(text).toMatchObject({ heading: "Set your spending limits to get a budget", daily: "Not set" });
    expect(text.explanation).toMatch(/until you set a daily limit and a monthly limit\./);
    // Version 2 recommended an amount from the test limit alone.
    expect(rec(POLICY_V2.settings, { ...COMPLETE_COSTS, ...testOnly }).budget.status).toBe("recommended");
    // With all three: an amount.
    expect(rec(POLICY_V3.settings).budget).toMatchObject({ status: "recommended", test_budget: 210 });
  });
});

describe("attribution reconciliation before any increase (version 3)", () => {
  // 40 matured sales for $760 ($19 each): the statistics justify scaling.
  const strong = days(20, "2026-11-17", 38, 2);
  const placedOrders = (placed: number, patch: Partial<ReconciliationEvidence> = {}) => evidence({ placed, paid: placed, ...patch });

  it("scales when Meta's purchases reconcile with Shopify's orders, and says so", () => {
    const f = judge(strong, POLICY_V3.settings, placedOrders(45));
    expect(f.action).toBe("SCALE");
    expect(f.reconciliation).toMatchObject({ status: "reconciled", scaling_allowed: true, meta_purchases: 40, basis: "placed", ceiling: 45, allowed: 56 });
  });

  it("withholds scaling when Meta reports more purchases than the product had orders, and explains it", () => {
    // 40 reported, 30 orders: at most 30 × 1.2 + 2 = 38 reconcile.
    const f = judge(strong, POLICY_V3.settings, placedOrders(30));
    expect(f).toMatchObject({ action: "CONTINUE", reasons: ["ATTRIBUTION_OVER_COUNT"], next_daily_budget: null,
      reconciliation: { status: "over_count", scaling_allowed: false, ceiling: 30, allowed: 38 } });
    expect(f.explanation.at(-1)).toMatch(/Meta reports 40 purchase\(s\).*only 30 placed Shopify order\(s\).*reported twice/);
    expect(judge(strong, POLICY_V3.settings, placedOrders(32)).action).toBe("SCALE");     // 32 × 1.2 + 2 = 40
  });

  it("withholds scaling on stale or unreadable evidence", () => {
    // Meta reports purchases up to 2026-11-17; Shopify's newest order is from 2026-11-16 (before 2026-11-17 less 14 hours).
    const behind = judge(strong, POLICY_V3.settings, placedOrders(45, { orders_fresh_at: "2026-11-16T09:00:00Z" }));
    expect(behind).toMatchObject({ action: "CONTINUE", reasons: ["ATTRIBUTION_EVIDENCE_STALE"] });
    expect(behind.reconciliation!.explanation).toMatch(/Meta reports purchases on 2026-11-17, but Shopify's newest order on record is from 2026-11-16T09:00:00Z/);
    // A quiet shop is not stale: its newest order (2026-11-17, a week ago) reaches Meta's last reported purchase.
    expect(judge(strong, POLICY_V3.settings, placedOrders(45, { orders_fresh_at: "2026-11-17T06:00:00Z" })).action).toBe("SCALE");
    expect(judge(strong, POLICY_V3.settings, null)).toMatchObject({ action: "CONTINUE", reasons: ["ATTRIBUTION_UNRECONCILABLE"] });
    // Results last entered a week ago are stale too.
    const old = evaluateCampaign({ campaign: campaign(strong), shopCurrency: "USD", current: [rec(POLICY_V3.settings)], policy: POLICY_V3.settings,
      asOf: AS_OF, dailyLimit: 1000, reconciliation: placedOrders(45) });
    expect(old).toMatchObject({ action: "CONTINUE", reasons: ["ATTRIBUTION_EVIDENCE_STALE"] });
  });

  it("scales after a manual review that covers the matured results, and records it", () => {
    const review = { through_day: "2026-11-17", outcome: "confirmed" as const, note: "Pixel removed; Meta counts only the Conversions API.",
      reviewed_by: "user_1", reviewed_at: "2026-11-23T10:00:00Z" };
    const f = judge(strong, POLICY_V3.settings, placedOrders(30, { review }));
    expect(f).toMatchObject({ action: "SCALE", reasons: ["ATTRIBUTION_REVIEWED"], reconciliation: { status: "reviewed", scaling_allowed: true } });
    expect(f.reconciliation!.explanation).toMatch(/Reviewed by user_1 .* through 2026-11-17 \(confirmed\): Pixel removed/);
    // A review of earlier results does not cover new ones.
    expect(judge(strong, POLICY_V3.settings, placedOrders(30, { review: { ...review, through_day: "2026-11-10" } })).action).toBe("CONTINUE");
  });

  it("uses the purchase events Omnitarget sent as the ceiling when Meta counts paid orders and they come from Omnitarget", () => {
    const paidBasis = { ...POLICY_V3.settings };
    const built = buildScenario({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ...LIMITS, purchase_event_basis: 1 }, policy: paidBasis });
    const current = recommendProduct({ ...built, asOf: AS_OF, freshness: built.evidence.freshness });
    const f = evaluateCampaign({ campaign: campaign([...strong, ...days(6, "2026-11-23", 0, 0)]), shopCurrency: "USD", current: [current], policy: paidBasis,
      asOf: AS_OF, dailyLimit: 1000, reconciliation: evidence({ placed: 60, paid: 50, capi_sent: 31, capi_connected: true }) });
    // 31 events sent (some failed to send): at most 31 × 1.2 + 2 = 39 reconcile; Meta reports 40.
    expect(f).toMatchObject({ action: "CONTINUE", reconciliation: { status: "over_count", basis: "paid", ceiling_source: "capi_events", ceiling: 31, allowed: 39 } });
  });

  it("never stands in the way of stopping or pausing, and leaves version 2 as it was", () => {
    // Losing campaign, counts that do not reconcile: still paused.
    const losing = days(20, "2026-11-17", 60, 1);              // $1,200 for 20 sales: $60 each
    expect(judge(losing, POLICY_V3.settings, null).action).toBe("PAUSE_REVISE");
    // Loss limit reached: still stopped.
    expect(judge(losing, POLICY_V3.settings, null, { max_loss: 300 }).action).toBe("STOP");
    // Version 2: no reconciliation, scaling as before.
    const v2 = evaluateCampaign({ campaign: campaign(strong), shopCurrency: "USD", current: [rec(POLICY_V2.settings)], policy: POLICY_V2.settings, asOf: AS_OF, dailyLimit: 1000 });
    expect(v2.action).toBe("SCALE");
    expect(v2.reconciliation).toBeUndefined();
  });
});

describe("recorded campaign evaluations", () => {
  it("recompute exactly from the stored arguments (as recorded by evaluateShopCampaigns)", () => {
    const args: Parameters<typeof evaluateCampaign>[0] = { campaign: { ...campaign([...days(20, "2026-11-17", 38, 2), ...days(6, "2026-11-23", 0, 0)]), daily_budget: 38 },
      shopCurrency: "USD", current: [rec(POLICY_V3.settings)], policy: POLICY_V3.settings, asOf: AS_OF, dailyLimit: 1000,
      reconciliation: evidence({ placed: 30, paid: 30, review: { through_day: "2026-11-17", outcome: "confirmed", note: "Checked.", reviewed_by: "u", reviewed_at: "2026-11-23T00:00:00Z" } }) };
    const stored = JSON.parse(JSON.stringify({ inputs: args, output: evaluateCampaign(args) }));
    expect(stored.output.action).toBe("SCALE");
    expect(JSON.parse(JSON.stringify(evaluateCampaign(stored.inputs)))).toEqual(stored.output);
  });

  it("reads the database's evidence strictly", () => {
    expect(normaliseReconciliationEvidence(null)).toBeNull();
    expect(normaliseReconciliationEvidence({ from: "2026-11-08T23:00:00+00:00", to: AS_OF, timezone: "Africa/Lagos", placed: "3", paid: 2, capi_sent: 1,
      capi_connected: true, meta_visit_orders: 2, journey_known_orders: 3, orders_fresh_at: "2026-11-24T08:00:00+00:00",
      review: { through_day: "2026-11-17", outcome: "corrected", note: "n", reviewed_by: "u", reviewed_at: "2026-11-23T10:00:00+00:00" } }))
      .toMatchObject({ placed: 3, paid: 2, capi_connected: true, review: { outcome: "corrected", through_day: "2026-11-17" } });
  });
});
