import { describe, expect, it } from "vitest";
import { evaluateCampaign, measureCampaign, type CampaignDay, type TrackedCampaign } from "./feedback";
import { recommendProduct } from "./recommend";
import { exactBinomialBounds, poissonBounds, wilsonBounds } from "./stats";
import { buildScenario, HEALTHY_80 } from "./__fixtures__/scenario";
import { POLICY_V2 } from "./__fixtures__/policy-v2";

/**
 * Phase 4 finalisation: the statistical audit, verified. Coverage is computed EXACTLY by enumerating the binomial or
 * Poisson distribution; the campaign rules are simulated with a seeded generator, so every figure is reproducible.
 * The figures quoted in architecture/phase-4-economics.md ("Statistics audit") come from this file.
 *
 * "90%" throughout is ONE-SIDED: each decision (pause, scale, stress a rate) uses the one bound it needs at 90%.
 * The two bounds shown together are therefore an 80% two-sided range.
 */
const CONFIDENCE = 0.9;
const lnFactorial = (n: number) => { let s = 0; for (let i = 2; i <= n; i += 1) s += Math.log(i); return s; };
const poissonPmf = (k: number, lambda: number) => Math.exp(-lambda + k * Math.log(lambda) - lnFactorial(k));
const binomialPmf = (k: number, n: number, p: number) => Math.exp(lnFactorial(n) - lnFactorial(k) - lnFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
/** mulberry32: a small, seeded generator so simulations are identical on every run. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const drawPoisson = (random: () => number, lambda: number) => { const limit = Math.exp(-lambda); let k = 0; let p = 1; do { k += 1; p *= random(); } while (p > limit); return k - 1; };

/** One-sided coverage of a proportion bound, exactly. */
function proportionCoverage(bounds: typeof wilsonBounds, n: number, p: number) {
  let upper = 0;
  let lower = 0;
  for (let k = 0; k <= n; k += 1) {
    const b = bounds(k, n, CONFIDENCE);
    const q = binomialPmf(k, n, p);
    if (b.upper >= p) upper += q;
    if (b.lower <= p) lower += q;
  }
  return { upper, lower };
}
const SIZES = [10, 20, 30, 50, 100, 200];
const RATES = [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5];

describe("rates: refund, return, paid-share and failed-delivery bounds", () => {
  it("exact (Clopper–Pearson) bounds solve their defining equations", () => {
    // Nothing refunded in 20 orders: the 90% upper bound is 1 − 0.1^(1/20) = 10.9%.
    expect(exactBinomialBounds(0, 20, CONFIDENCE).upper).toBeCloseTo(1 - 0.1 ** (1 / 20), 9);
    expect(exactBinomialBounds(20, 20, CONFIDENCE).lower).toBeCloseTo(0.1 ** (1 / 20), 9);
    // 5 of 50: at the upper bound, seeing 5 or fewer has probability exactly 10%; at the lower, 5 or more has 10%.
    const b = exactBinomialBounds(5, 50, CONFIDENCE);
    const cdf = (k: number, p: number) => Array.from({ length: k + 1 }, (_, i) => binomialPmf(i, 50, p)).reduce((t, x) => t + x, 0);
    expect(cdf(5, b.upper)).toBeCloseTo(0.1, 9);
    expect(1 - cdf(4, b.lower)).toBeCloseTo(0.1, 9);
  });

  it("policy version 2's exact bounds hold at least 90% one-sided at every size and rate", () => {
    for (const n of SIZES) for (const p of RATES) {
      const c = proportionCoverage(exactBinomialBounds, n, p);
      expect(Math.min(c.upper, c.lower), `n=${n} p=${p}`).toBeGreaterThanOrEqual(CONFIDENCE - 1e-9);
    }
  });

  it("the Wilson bounds that version 1 used do not: as low as 81% at 20 orders (why version 2 changed them)", () => {
    let worst = 1;
    for (const n of SIZES) for (const p of RATES) { const c = proportionCoverage(wilsonBounds, n, p); worst = Math.min(worst, c.upper, c.lower); }
    expect(worst).toBeLessThan(0.85);
    expect(proportionCoverage(wilsonBounds, 20, 0.08).upper).toBeCloseTo(0.8113, 3);
  });
});

describe("cost per sale: exact Poisson (Garwood) bounds", () => {
  it("each bound holds at least 90% one-sided for any expected number of sales", () => {
    for (const lambda of [0.2, 0.5, 1, 2.3, 5, 10, 20, 40, 80, 160]) {
      let upper = 0;
      let lower = 0;
      for (let k = 0; k < 600; k += 1) {
        const q = poissonPmf(k, lambda);
        const b = poissonBounds(k, CONFIDENCE);
        if (b.upper >= lambda) upper += q;
        if (b.lower <= lambda) lower += q;
      }
      expect(Math.min(upper, lower), `λ=${lambda}`).toBeGreaterThanOrEqual(CONFIDENCE - 1e-9);
    }
  });

  it("the no-sale rule: with no sales, pause once spend passes 2.3026 × break-even; a break-even campaign shows no sale that long only 10% of the time", () => {
    expect(poissonBounds(0, CONFIDENCE).upper).toBeCloseTo(Math.log(10), 9);
    expect(poissonPmf(0, Math.log(10))).toBeCloseTo(0.1, 12);
  });

  it("never derives the cost-per-sale range from the conversion rate", () => {
    const at = (clicks: number | null) => measureCampaign(Array.from({ length: 10 }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, "0")}`, spend: 30,
      conversions: 1, conversion_value: null, clicks, impressions: null, fx_to_shop: 1, fx_source: "same currency" })), "USD", "2026-11-24T00:00:00Z", POLICY_V2.settings);
    const withClicks = at(40);
    const without = at(null);
    expect([withClicks.cpa_lower, withClicks.cpa_upper]).toEqual([without.cpa_lower, without.cpa_upper]);
    expect(without.conversion_rate).toBeNull();
  });
});

/**
 * The campaign rules, simulated. The $80 product (break-even $30, target $21) runs at $34 a day; sales each day are
 * Poisson with mean 34 ÷ the true cost per sale. The rules are checked every day from day 8 to day 35 (28 checks,
 * as a merchant who looks daily would); the first PAUSE or SCALE ends the run. 3,000 runs per true cost per sale.
 */
function simulate(trueCpa: number, seed: number, runs = 3000, purpose: "test" | "diagnostic" = "test") {
  const start = Date.parse("2026-11-01T00:00:00Z");
  const built = buildScenario({ ...HEALTHY_80, inputs: { ...HEALTHY_80.inputs, ad_test_limit: 1000, ad_max_loss: 100_000 } });
  const current = recommendProduct({ ...built, asOf: "2026-11-01T00:00:00Z", freshness: built.evidence.freshness });
  const random = seeded(seed);
  const tally = { pause: 0, scale: 0, scaleBelowMinimum: 0, scaleWithoutMaturity: 0 };
  for (let run = 0; run < runs; run += 1) {
    const results: CampaignDay[] = [];
    for (let d = 0; d < 35; d += 1) {
      results.push({ day: new Date(start + d * 86_400_000).toISOString().slice(0, 10), spend: 34, conversions: drawPoisson(random, 34 / trueCpa),
        conversion_value: null, clicks: null, impressions: null, fx_to_shop: 1, fx_source: "same currency" });
      if (d < 7) continue;
      const campaign: TrackedCampaign = { id: "c", name: "t", product_ids: [1], status: "active", currency: "USD", daily_budget: 34, authorised_budget: 100_000,
        max_loss: 100_000, recommendation_run_id: null, started_on: "2026-11-01", last_scaled_on: null, purpose, results: [...results] };
      const f = evaluateCampaign({ campaign, shopCurrency: "USD", current: [current], policy: built.policy, asOf: new Date(start + (d + 1) * 86_400_000).toISOString(), dailyLimit: 1000 });
      if (f.action === "SCALE") {
        tally.scale += 1;
        if (f.measure.matured_conversions < built.policy.min_scale_conversions) tally.scaleBelowMinimum += 1;
        if (f.measure.matured_days === 0) tally.scaleWithoutMaturity += 1;
        break;
      }
      if (f.action === "PAUSE_REVISE") { tally.pause += 1; break; }
    }
  }
  return { pause: tally.pause / runs, scale: tally.scale / runs, scaleBelowMinimum: tally.scaleBelowMinimum, scaleWithoutMaturity: tally.scaleWithoutMaturity };
}

describe("the campaign rules under repeated daily checks (seeded simulation)", () => {
  const at = Object.fromEntries([17, 21, 25, 30, 36, 45].map((cpa) => [cpa, simulate(cpa, 20261124 + cpa)]));
  if (process.env.STATS_OUT) console.log(JSON.stringify(at));

  it("rarely pauses a profitable campaign: about 3% at the $21 target, about 1 in 10 at $25", () => {
    expect(at[21].pause).toBeLessThanOrEqual(0.05);
    expect(at[25].pause).toBeLessThanOrEqual(0.12);
    expect(at[17].pause).toBeLessThanOrEqual(0.02);
  });

  it("rarely scales a campaign that is not profitable: about 1 in 10 at exactly break-even, about 2% at 20% above it", () => {
    expect(at[30].scale).toBeLessThanOrEqual(0.12);
    expect(at[36].scale).toBeLessThanOrEqual(0.03);
    expect(at[45].scale).toBeLessThanOrEqual(0.005);
  });

  it("still acts on clear results: scales most campaigns well under target, pauses most well above break-even", () => {
    expect(at[17].scale).toBeGreaterThanOrEqual(0.9);
    expect(at[45].pause).toBeGreaterThanOrEqual(0.8);
  });

  it("never scales on fewer than 20 matured sales or on immature days, and never scales a diagnostic campaign", () => {
    for (const r of Object.values(at)) expect([r.scaleBelowMinimum, r.scaleWithoutMaturity]).toEqual([0, 0]);
    expect(simulate(17, 7, 500, "diagnostic").scale).toBe(0);
  });

  it("a single check holds the stated 10%: at 14 matured days a break-even campaign is paused at most 10% of the time", () => {
    // Exactly: pause when the lowest plausible CPA, spend ÷ upper(k), rounded down to the cent, exceeds $30.
    const spend = 14 * 34;
    let pause = 0;
    for (let k = 0; k < 200; k += 1) if (Math.floor((spend / poissonBounds(k, CONFIDENCE).upper) * 100) / 100 > 30) pause += poissonPmf(k, spend / 30);
    expect(pause).toBeLessThanOrEqual(0.1);
    expect(pause).toBeGreaterThan(0.05);
  });
});
