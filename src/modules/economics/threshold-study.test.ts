import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateCampaign, type CampaignDay, type TrackedCampaign } from "./feedback";
import { recommendProduct } from "./recommend";
import { buildScenario, HEALTHY_80 } from "./__fixtures__/scenario";
import { POLICY_V2 } from "./__fixtures__/policy-v2";
import { decide, FIRST_CHECK_DAY, HORIZON_DAYS, reportedBy, runChecks, seeded, simulateCampaign, totalsByCheck, type Economics, type Maturity, type Thresholds }
  from "./__fixtures__/campaign-simulator";

/**
 * The scaling and pausing threshold study (Phase 4 finalisation, policy version 3). The $80 product: break-even
 * $30, target $21. Figures in architecture/phase-4-economics.md, "Scaling and pausing thresholds", come from
 * study() below (STUDY_OUT writes them all); the assertions pin the ones the recommendation rests on.
 */
const ECONOMICS: Economics = { breakEven: 30, target: 21, minScaleConversions: 20, minJudgementSpendMultiple: 1, lagDays: 7 };
const TRUE_CPAS = [18, 21, 25, 27, 30, 36, 45];
const DAILY_SPEND = [15, 30, 60, 120];                       // 0.5, 1, 2 and 4 sales a day at break-even
const MATURITIES: Maturity[] = ["complete", "late10", "late25", "over15"];
const LEVELS = [0.8, 0.9, 0.95, 0.975, 0.99];

export interface Cell { trueCpa: number; dailySpend: number; maturity: Maturity; scale: number; pause: number;
  scaled: number; paused: number; medianScaleDay: number | null; medianPauseDay: number | null; meanSpend: number }

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

function study(runs: number, cpas = TRUE_CPAS, spends = DAILY_SPEND, maturities = MATURITIES, levels = LEVELS): Cell[] {
  const cells: Cell[] = [];
  for (const maturity of maturities) for (const dailySpend of spends) for (const trueCpa of cpas) {
    // The seed depends only on the campaign's conditions, so any subset reproduces the full study's figures.
    const random = seeded(20261125 + MATURITIES.indexOf(maturity) * 100_000 + dailySpend * 100 + trueCpa);
    const campaigns = Array.from({ length: runs }, () => totalsByCheck(simulateCampaign(random, trueCpa, dailySpend, maturity), ECONOMICS.lagDays));
    for (const scale of levels) for (const pause of levels) {
      const outcomes = campaigns.map((c) => runChecks(c, dailySpend, ECONOMICS, { scale, pause }, null));
      const scaledDays = outcomes.filter((o) => o.decision === "SCALE").map((o) => o.day as number);
      const pausedDays = outcomes.filter((o) => o.decision === "PAUSE_REVISE").map((o) => o.day as number);
      cells.push({ trueCpa, dailySpend, maturity, scale, pause, scaled: scaledDays.length / runs, paused: pausedDays.length / runs,
        medianScaleDay: median(scaledDays), medianPauseDay: median(pausedDays), meanSpend: outcomes.reduce((t, o) => t + o.spend, 0) / runs });
    }
  }
  return cells;
}

describe("the simulator applies the engine's rules exactly", () => {
  it("reaches evaluateCampaign's decision on every daily check of sampled campaigns, at equal and unequal thresholds", () => {
    const built = buildScenario({ ...HEALTHY_80, inputs: { ...HEALTHY_80.inputs, ad_test_limit: 1000, ad_max_loss: 600 }, policy: POLICY_V2.settings });
    const current = recommendProduct({ ...built, asOf: "2026-11-01T00:00:00Z", freshness: built.evidence.freshness });
    expect([current.economics.break_even_cpa, current.economics.target_cpa]).toEqual([30, 21]);
    const start = Date.parse("2026-11-01T00:00:00Z");
    const pairs: Thresholds[] = [{ scale: 0.9, pause: 0.9 }, { scale: 0.95, pause: 0.9 }, { scale: 0.975, pause: 0.8 }, { scale: 0.8, pause: 0.99 }];
    let checks = 0;
    let seed = 7;
    for (const maturity of ["complete", "late25", "over15"] as Maturity[]) for (const dailySpend of [30, 120]) for (const trueCpa of [21, 30, 45]) {
      const random = seeded(seed++);
      for (let run = 0; run < 12; run += 1) {
        const days = simulateCampaign(random, trueCpa, dailySpend, maturity);
        for (const t of pairs) for (const maxLoss of [null, 600]) {
          const policy = { ...POLICY_V2.settings, scale_confidence: t.scale, pause_confidence: t.pause, require_spending_limits: false };
          for (let lastDay = FIRST_CHECK_DAY; lastDay < HORIZON_DAYS; lastDay += 1) {
            const reported = reportedBy(days, lastDay);
            const results: CampaignDay[] = reported.map((conversions, i) => ({ day: new Date(start + i * 86_400_000).toISOString().slice(0, 10), spend: dailySpend,
              conversions, conversion_value: null, clicks: null, impressions: null, fx_to_shop: 1, fx_source: "same currency" }));
            const campaign: TrackedCampaign = { id: "c", name: "t", product_ids: [1], status: "active", currency: "USD", daily_budget: dailySpend,
              authorised_budget: 100_000, max_loss: maxLoss, recommendation_run_id: null, started_on: "2026-11-01", last_scaled_on: null, purpose: "test", results };
            // The study covers the statistical rules; Meta's counts reconcile with Shopify here (the safeguard has its own tests).
            const asOf = new Date(start + (lastDay + 1) * 86_400_000).toISOString();
            const engine = evaluateCampaign({ campaign, shopCurrency: "USD", current: [current], policy, dailyLimit: 1000, asOf,
              reconciliation: { from: "2026-10-31T00:00:00Z", to: asOf, timezone: "UTC", placed: 100_000, paid: 100_000, capi_sent: 0,
                capi_connected: false, orders_fresh_at: asOf, review: null } }).action;
            const mapped = engine === "HOLD_OPTIMISE" ? "CONTINUE" : engine;
            expect(decide(reported, dailySpend, lastDay, ECONOMICS, t, maxLoss), `${maturity} $${dailySpend}/day CPA ${trueCpa} ${JSON.stringify(t)} day ${lastDay}`).toBe(mapped);
            checks += 1;
          }
          // The fast path (running totals) agrees with the day-by-day one.
          let slow: [string | null, number | null] = [null, null];
          for (let d = FIRST_CHECK_DAY; d < HORIZON_DAYS; d += 1) {
            const x = decide(reportedBy(days, d), dailySpend, d, ECONOMICS, t, maxLoss);
            if (x === "PAUSE_REVISE" || x === "STOP" || x === "SCALE") { slow = [x, d + 1]; break; }
          }
          const fast = runChecks(totalsByCheck(days, ECONOMICS.lagDays), dailySpend, ECONOMICS, t, maxLoss);
          expect([fast.decision, fast.day]).toEqual(slow);
        }
      }
    }
    expect(checks).toBe(3 * 2 * 3 * 12 * 4 * 2 * 28);
  }, 300_000);
});

describe("the study's findings (3,000 campaigns per condition, every threshold pair)", () => {
  let cells: Cell[] = [];
  const pick = (f: Partial<Cell>) => cells.filter((c) => Object.entries(f).every(([k, v]) => c[k as keyof Cell] === v));
  const one = (f: Partial<Cell>) => pick(f)[0];
  /** The worst case over the four sales volumes. */
  const worst = (f: Partial<Cell>, k: "scaled" | "paused") => Math.max(...pick(f).map((c) => c[k]));
  const RECOMMENDED = { scale: 0.975, pause: 0.95 };

  it("runs every condition and threshold pair", () => {
    cells = study(3000);
    if (process.env.STUDY_OUT) writeFileSync(process.env.STUDY_OUT, JSON.stringify(cells));
    expect(cells.length).toBe(TRUE_CPAS.length * DAILY_SPEND.length * MATURITIES.length * LEVELS.length * LEVELS.length);
  }, 600_000);

  it("below about 93% the scaling confidence changes nothing: with 20+ sales, 'at or under the $21 target' is the stricter test", () => {
    expect(pick({ scale: 0.8 }).length).toBe(TRUE_CPAS.length * DAILY_SPEND.length * MATURITIES.length * LEVELS.length);
    for (const c of pick({ scale: 0.8 })) {
      const at90 = one({ trueCpa: c.trueCpa, dailySpend: c.dailySpend, maturity: c.maturity, pause: c.pause, scale: 0.9 });
      expect(at90.scaled).toBe(c.scaled);
    }
  });

  it("break-even products scaled (worst volume): 11% at 90%, 9% at 95%, 6% at 97.5%, 3% at 99%", () => {
    const at = (scale: number) => worst({ trueCpa: 30, maturity: "complete", scale, pause: 0.95 }, "scaled");
    expect(at(0.9)).toBeCloseTo(0.113, 2);
    expect(at(0.95)).toBeCloseTo(0.093, 2);
    expect(at(0.975)).toBeCloseTo(0.059, 2);
    expect(at(0.99)).toBeCloseTo(0.028, 2);
  });

  it("each step up costs more profitable scale-ups per unprofitable one avoided; 97.5% is the elbow at one sale a day", () => {
    const s = (cpa: number, scale: number) => one({ trueCpa: cpa, dailySpend: 30, maturity: "complete", scale, pause: 0.95 }).scaled;
    const ratio = (a: number, b: number) => (s(21, a) - s(21, b) + s(18, a) - s(18, b)) / (s(30, a) - s(30, b) + s(36, a) - s(36, b));
    const [r1, r2, r3] = [ratio(0.9, 0.95), ratio(0.95, 0.975), ratio(0.975, 0.99)];
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(2);
    expect(r3).toBeGreaterThan(4);
  });

  it("pausing at 90% wrongly pauses 8% of on-target products when 10% of sales arrive late; 95% keeps it under 1 in 20", () => {
    const pausedOnTarget = (pause: number, maturity: Maturity) => worst({ trueCpa: 21, maturity, scale: 0.975, pause }, "paused");
    expect(pausedOnTarget(0.9, "late10")).toBeGreaterThan(0.075);
    expect(pausedOnTarget(0.95, "late10")).toBeLessThan(0.04);
    expect(pausedOnTarget(0.95, "complete")).toBeLessThan(0.025);
    // 97.5% would leave most products losing 20% a sale running for five weeks at low volume.
    expect(one({ trueCpa: 36, dailySpend: 15, maturity: "complete", scale: 0.975, pause: 0.975 }).paused).toBeLessThan(0.2);
    expect(one({ trueCpa: 36, dailySpend: 15, maturity: "complete", scale: 0.975, pause: 0.95 }).paused).toBeGreaterThan(0.25);
  });

  it("the recommended pair (scale 97.5%, pause 95%): loss-makers almost never scaled, profitable products rarely paused", () => {
    expect(worst({ trueCpa: 36, maturity: "complete", ...RECOMMENDED }, "scaled")).toBeLessThan(0.007);
    expect(worst({ trueCpa: 25, maturity: "complete", ...RECOMMENDED }, "paused")).toBeLessThan(0.07);
    expect(one({ trueCpa: 21, dailySpend: 30, maturity: "complete", ...RECOMMENDED }).scaled).toBeGreaterThan(0.63);
    // The cost: products 50% above break-even lose about a fifth more before they are paused than at 90%.
    const lost = (pause: number, d: number) => one({ trueCpa: 45, dailySpend: d, maturity: "complete", scale: 0.975, pause }).meanSpend / 3;
    for (const d of DAILY_SPEND) expect(lost(0.95, d) / lost(0.9, d)).toBeLessThan(1.25);
  });

  it("no threshold fixes a counting error: with 15% of sales over-reported, break-even products scale 15% of the time even at 99%", () => {
    expect(worst({ trueCpa: 30, maturity: "over15", scale: 0.99, pause: 0.95 }, "scaled")).toBeGreaterThan(0.15);
    expect(worst({ trueCpa: 30, maturity: "over15", ...RECOMMENDED }, "scaled")).toBeGreaterThan(0.2);
  });
});

export { study };
