import { poissonBounds } from "../stats";

/**
 * Test fixture for the scaling and pausing threshold study (Phase 4 finalisation, policy version 3).
 *
 * Simulates single-product campaigns day by day and applies the campaign rules of feedback.ts (evaluateCampaign:
 * the loss limit, the wait for matured evidence, pause, scale) to what the ad platform has REPORTED by each daily
 * check. Every pair of thresholds is evaluated on the same simulated campaigns, so the comparison between them is
 * like for like. threshold-study.test.ts proves this reproduces evaluateCampaign's decision on every check of
 * sampled campaigns before any result is used.
 *
 * Assumptions (stated in architecture/phase-4-economics.md, "Scaling and pausing thresholds"):
 *  - real sales each day are Poisson with mean daily spend ÷ the true cost per sale (independent days, steady
 *    budget and performance over the five weeks);
 *  - each sale is reported after a delay: "complete" maturity reports 60% the same day and the rest within 6 days,
 *    inside the 7-day attribution wait; "late10" / "late25" report 10% / 25% of sales 7–20 days later, so some are
 *    still missing when a day counts as matured; "over15" adds 15% phantom sales that the platform reports but
 *    never happened (e.g. the same order counted twice);
 *  - checks run daily from day 8 to day 35; the first PAUSE, STOP or SCALE ends the run.
 */
export type Maturity = "complete" | "late10" | "late25" | "over15";
export interface Thresholds { scale: number; pause: number }
export interface Economics { breakEven: number; target: number; minScaleConversions: number; minJudgementSpendMultiple: number; lagDays: number }
export interface SimulatedDay { real: number; delays: number[] }

export const HORIZON_DAYS = 35;
export const FIRST_CHECK_DAY = 7;

export function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(random: () => number, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do { k += 1; p *= random(); } while (p > limit);
  return k - 1;
}
function delay(random: () => number, maturity: Maturity): number {
  const lateShare = maturity === "late10" ? 0.1 : maturity === "late25" ? 0.25 : 0;
  if (lateShare > 0 && random() < lateShare) return 7 + Math.floor(random() * 14);
  return random() < 0.6 ? 0 : 1 + Math.floor(random() * 6);
}

/** One campaign: real sales per day and the reporting delay of every reported sale (phantom ones included). */
export function simulateCampaign(random: () => number, trueCpa: number, dailySpend: number, maturity: Maturity): SimulatedDay[] {
  const mean = dailySpend / trueCpa;
  return Array.from({ length: HORIZON_DAYS }, () => {
    const real = poisson(random, mean);
    const phantom = maturity === "over15" ? poisson(random, 0.15 * mean) : 0;
    return { real, delays: Array.from({ length: real + phantom }, () => delay(random, maturity)) };
  });
}

/** What the platform has reported for each day by the end of day `lastDay` (the check runs the next morning). */
export function reportedBy(days: SimulatedDay[], lastDay: number): number[] {
  return days.slice(0, lastDay + 1).map((d, i) => d.delays.filter((x) => i + x <= lastDay).length);
}

/** Running totals at each check: everything reported, and what is reported for matured days (lag as in the engine). */
export function totalsByCheck(days: SimulatedDay[], lagDays: number): { all: Int32Array; matured: Int32Array } {
  const all = new Int32Array(HORIZON_DAYS + 1);
  const matured = new Int32Array(HORIZON_DAYS + 1);
  days.forEach((d, i) => {
    for (const x of d.delays) {
      if (i + x < HORIZON_DAYS) all[i + x] += 1;
      const m = Math.max(i + x, i + lagDays - 1);
      if (m < HORIZON_DAYS) matured[m] += 1;
    }
  });
  for (let k = 1; k <= HORIZON_DAYS; k += 1) { all[k] += all[k - 1]; matured[k] += matured[k - 1]; }
  return { all, matured };
}

const boundTables = new Map<string, number[]>();
function bound(kind: "lower" | "upper", count: number, confidence: number): number {
  const key = `${kind}|${confidence}`;
  let table = boundTables.get(key);
  if (!table) { table = []; boundTables.set(key, table); }
  let v = table[count];
  if (v === undefined) { v = poissonBounds(count, confidence)[kind]; table[count] = v; }
  return v;
}
const EPSILON = 1e-6;
const cents = { down: (x: number) => Math.floor(x * 100 + EPSILON), up: (x: number) => Math.ceil(x * 100 - EPSILON) };

export type Decision = "STOP" | "WAIT" | "PAUSE_REVISE" | "SCALE" | "CONTINUE";

/**
 * The rules of evaluateCampaign for a running single-product campaign with a steady daily budget, at the check on
 * the morning after `lastDay`. maxLoss null: no loss limit.
 */
export function decide(reported: number[], dailySpend: number, lastDay: number, e: Economics, t: Thresholds, maxLoss: number | null): Decision {
  const maturedThrough = lastDay + 1 - e.lagDays;
  let all = 0;
  let matured = 0;
  for (let i = 0; i < reported.length; i += 1) { all += reported[i]; if (i <= maturedThrough) matured += reported[i]; }
  return decideTotals(all, matured, dailySpend, lastDay, e, t, maxLoss);
}

/** decide(), from the totals reported in all and for matured days. */
export function decideTotals(all: number, matured: number, dailySpend: number, lastDay: number, e: Economics, t: Thresholds, maxLoss: number | null): Decision {
  const maturedThrough = lastDay + 1 - e.lagDays;
  const spendAll = dailySpend * (lastDay + 1);
  const maturedDays = Math.max(0, maturedThrough + 1);
  const spendMatured = dailySpend * maturedDays;
  if (maxLoss !== null && (cents.up(spendAll) - cents.down(all * e.breakEven)) / 100 >= maxLoss) return "STOP";
  if (maturedDays === 0 || (spendMatured < e.minJudgementSpendMultiple * e.breakEven && matured < e.minScaleConversions)) return "WAIT";
  if (cents.down(spendMatured / bound("upper", matured, t.pause)) / 100 > e.breakEven) return "PAUSE_REVISE";
  if (matured >= e.minScaleConversions && cents.up(spendMatured / matured) / 100 <= e.target
    && cents.up(spendMatured / bound("lower", matured, t.scale)) / 100 <= e.breakEven) return "SCALE";
  return "CONTINUE";
}

export interface Outcome { decision: "PAUSE_REVISE" | "STOP" | "SCALE" | null; day: number | null; spend: number }

/** Runs the daily checks on one campaign; the first PAUSE, STOP or SCALE ends it. */
export function runChecks(days: SimulatedDay[] | ReturnType<typeof totalsByCheck>, dailySpend: number, e: Economics, t: Thresholds, maxLoss: number | null): Outcome {
  const totals = Array.isArray(days) ? totalsByCheck(days, e.lagDays) : days;
  for (let lastDay = FIRST_CHECK_DAY; lastDay < HORIZON_DAYS; lastDay += 1) {
    const d = decideTotals(totals.all[lastDay], totals.matured[lastDay], dailySpend, lastDay, e, t, maxLoss);
    if (d === "PAUSE_REVISE" || d === "STOP" || d === "SCALE") return { decision: d, day: lastDay + 1, spend: dailySpend * (lastDay + 1) };
  }
  return { decision: null, day: null, spend: dailySpend * HORIZON_DAYS };
}
