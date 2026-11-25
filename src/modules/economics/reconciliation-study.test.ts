import { describe, expect, it } from "vitest";
import { allowedPurchases, RECONCILIATION } from "./reconciliation";
import { seeded } from "./__fixtures__/campaign-simulator";

/**
 * Where to set the reconciliation tolerance (Phase 4 closure). Meta's purchase count for a campaign is compared with the
 * product's Shopify orders over the campaign's period; the tolerance must let legitimate attribution through and stop
 * over-counting. Seeded simulation, 5,000 campaigns per condition, checked after 21 days.
 *
 * Model (stated in architecture/phase-4-economics.md, "Attribution reconciliation"):
 *  - each day the product gets ad-driven orders (Poisson, mean `adPerDay`) and organic orders (Poisson, so that
 *    ad-driven orders are `share` of all orders); the window starts a day early, so it also holds one day of organic orders;
 *  - LEGITIMATE attribution: Meta counts each ad-driven order with probability `capture` (lost tracking), claims each
 *    organic order with probability `overlap` (view-through, people who saw an ad and bought anyway), and adds
 *    `modelled` × that count of modelled conversions (Meta's statistical estimates for people it cannot track);
 *  - OVER-COUNTING adds `duplicate` × the counted purchases again (one order reported twice), or purchases of OTHER
 *    products by the campaign's visitors at `otherProducts` × the ad-driven rate.
 */
interface Condition { adPerDay: number; share: number; capture: number; overlap: number; modelled: number; duplicate: number; otherProducts: number }
const DAYS = 21;
const RUNS = 5000;
function poisson(random: () => number, mean: number) { const l = Math.exp(-mean); let k = 0; let p = 1; do { k += 1; p *= random(); } while (p > l); return k - 1; }
function binomial(random: () => number, n: number, p: number) { let k = 0; for (let i = 0; i < n; i += 1) if (random() < p) k += 1; return k; }

/** Pairs of (Meta's count, Shopify's orders) for one condition. */
function simulate(c: Condition, seed: number): Array<[number, number]> {
  const random = seeded(seed);
  const organicPerDay = (c.adPerDay * (1 - c.share)) / c.share;
  return Array.from({ length: RUNS }, () => {
    let meta = 0;
    let shopify = poisson(random, organicPerDay);                   // the extra day before the campaign
    for (let d = 0; d < DAYS; d += 1) {
      const ad = poisson(random, c.adPerDay);
      const organic = poisson(random, organicPerDay);
      shopify += ad + organic;
      const counted = binomial(random, ad, c.capture) + binomial(random, organic, c.overlap);
      meta += counted + poisson(random, c.modelled * counted) + binomial(random, counted, c.duplicate) + poisson(random, c.otherProducts * c.adPerDay);
    }
    return [meta, shopify] as [number, number];
  });
}
const flagged = (pairs: Array<[number, number]>, relative: number, absolute: number) =>
  pairs.filter(([meta, shopify]) => meta > Math.floor(shopify * (1 + relative) + 1e-9) + absolute).length / pairs.length;

const LEGITIMATE: Condition[] = [];
for (const adPerDay of [0.5, 1, 4]) for (const share of [0.5, 0.8, 0.95, 1]) for (const capture of [0.8, 1]) for (const overlap of [0, 0.2])
  for (const modelled of [0, 0.05, 0.1]) LEGITIMATE.push({ adPerDay, share, capture, overlap, modelled, duplicate: 0, otherProducts: 0 });
const OVER_COUNTING: Array<Condition & { label: string }> = [];
for (const adPerDay of [0.5, 1, 4]) for (const share of [0.5, 0.8, 0.95]) {
  const base = { adPerDay, share, capture: 0.9, overlap: 0.1, modelled: 0.05, otherProducts: 0 };
  OVER_COUNTING.push({ ...base, duplicate: 1, label: "every order twice (pixel and Conversions API, different event IDs)" });
  OVER_COUNTING.push({ ...base, duplicate: 0.5, label: "half of orders twice" });
  OVER_COUNTING.push({ ...base, duplicate: 0.15, label: "15% over-reported" });
  OVER_COUNTING.push({ ...base, duplicate: 0, otherProducts: 0.5, label: "other products bought by the campaign's visitors" });
}

const seedOf = (c: Condition) => 7 + Math.round(c.adPerDay * 10) * 100_000 + Math.round(c.share * 100) * 1000 + Math.round(c.capture * 10) * 100
  + Math.round(c.overlap * 10) * 10 + Math.round(c.modelled * 100) + Math.round(c.duplicate * 100) * 7 + Math.round(c.otherProducts * 10) * 13;

describe("the reconciliation tolerance", () => {
  const legitimate = LEGITIMATE.map((c) => ({ c, pairs: simulate(c, seedOf(c)) }));
  const overCounting = OVER_COUNTING.map((c) => ({ c, pairs: simulate(c, seedOf(c)) }));
  const worstLegitimate = (relative: number, absolute: number) => Math.max(...legitimate.map(({ pairs }) => flagged(pairs, relative, absolute)));
  const detection = (relative: number, absolute: number, f: (c: Condition & { label: string }) => boolean) =>
    overCounting.filter(({ c }) => f(c)).map(({ c, pairs }) => ({ label: c.label, adPerDay: c.adPerDay, share: c.share, caught: flagged(pairs, relative, absolute) }));

  if (process.env.STUDY_OUT) {
    const grid = [0, 0.05, 0.1, 0.15, 0.2].flatMap((relative) => [0, 1, 2, 3, 5].map((absolute) => ({ relative, absolute,
      worstLegitimate: worstLegitimate(relative, absolute), caught: detection(relative, absolute, () => true) })));
    console.log(JSON.stringify(grid));
  }

  it("with no tolerance, legitimate attribution with Meta's modelled conversions is held back", () => {
    expect(worstLegitimate(0, 0)).toBeGreaterThan(0.2);
  });

  it("20% plus 2 purchases is the least permissive setting that holds back at most 1% of legitimate campaigns in every condition", () => {
    const { relativeTolerance, absoluteTolerance } = RECONCILIATION;
    expect([relativeTolerance, absoluteTolerance]).toEqual([0.2, 2]);
    expect(worstLegitimate(relativeTolerance, absoluteTolerance)).toBeLessThan(0.01);
    // Every setting that allows fewer purchases at 30 orders holds back more than 1% of legitimate campaigns somewhere.
    const allowedAt30 = (relative: number, absolute: number) => Math.floor(30 * (1 + relative) + 1e-9) + absolute;
    expect(allowedAt30(relativeTolerance, absoluteTolerance)).toBe(allowedPurchases(30));
    for (const relative of [0, 0.05, 0.1, 0.15, 0.2]) for (const absolute of [0, 1, 2, 3, 5]) {
      if (allowedAt30(relative, absolute) < allowedPurchases(30)) expect(worstLegitimate(relative, absolute), `${relative} + ${absolute}`).toBeGreaterThan(0.01);
    }
  });

  it("catches double counting whenever Meta drives most of the product's sales, and says what it cannot see", () => {
    const caught = (label: string, share: number, adPerDay: number) =>
      detection(0.2, 2, (c) => c.label.startsWith(label) && c.share === share && c.adPerDay === adPerDay)[0].caught;
    expect(caught("every order twice", 0.8, 1)).toBeGreaterThan(0.85);
    for (const share of [0.8, 0.95]) expect(caught("every order twice", share, 4)).toBeGreaterThan(0.99);
    expect(caught("half of orders twice", 0.95, 4)).toBeGreaterThan(0.9);
    expect(caught("other products", 0.95, 4)).toBeGreaterThan(0.9);
    // What a ceiling cannot see: an over-count that stays under the product's own orders, because Meta drives only
    // part of its sales (doubling at half the sales) or the excess is small (15%).
    expect(caught("every order twice", 0.5, 4)).toBeLessThan(0.02);
    expect(caught("15% over-reported", 0.95, 4)).toBeLessThan(0.02);
  });
});
