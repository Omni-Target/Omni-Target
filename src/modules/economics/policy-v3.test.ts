import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeBriefEconomics } from "@/lib/brief-economics";
import { acquisitionFromCampaigns, evaluateCampaign, measureCampaign, type CampaignDay, type TrackedCampaign } from "./feedback";
import { parseEconomicsPolicy } from "./policy";
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
const judge = (results: CampaignDay[], policy: typeof POLICY_V3.settings) =>
  evaluateCampaign({ campaign: campaign(results), shopCurrency: "USD", current: [rec(policy)], policy, asOf: AS_OF, dailyLimit: 1000 });

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
