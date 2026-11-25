/**
 * Statistics the economics engine uses (Phase 4). Deterministic, no sampling.
 *  - proportions under policy version 2 (refund and return incidence, recovery, paid share, failed deliveries):
 *    one-sided exact (Clopper–Pearson) bounds, which hold the stated confidence at every sample size;
 *  - proportions under policy version 1, and the conversion rate shown beside a campaign: Wilson score bounds,
 *    which are approximate (the Phase 4 finalisation measured one-sided 90% Wilson coverage as low as 81% at
 *    n = 20; see finalisation-statistics.test.ts);
 *  - event counts for a fixed exposure (conversions for a spend): exact Poisson (Garwood) bounds, via the
 *    chi-square quantile, never a normal approximation of CPA.
 */

/** Inverse of the standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error("normalQuantile: p must be in (0, 1)");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** One-sided Wilson score bounds for successes out of n at the given confidence. */
export function wilsonBounds(successes: number, n: number, confidence: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const z = normalQuantile(confidence);
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return { lower: Math.max(0, (centre - margin) / denominator), upper: Math.min(1, (centre + margin) / denominator) };
}

/** ln Γ(x) (Lanczos). */
function logGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const coefficient of g) ser += coefficient / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised lower incomplete gamma P(a, x). */
export function regularisedGammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 1000; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // Continued fraction for Q, then P = 1 − Q.
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Quantile of the gamma(shape, 1) distribution, by bisection on P (deterministic). */
export function gammaQuantile(shape: number, p: number): number {
  let lo = 0;
  let hi = Math.max(1, shape * 10 + 50);
  while (regularisedGammaP(shape, hi) < p) hi *= 2;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (regularisedGammaP(shape, mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * One-sided exact (Garwood) bounds on a Poisson mean from an observed count:
 * lower = Gamma⁻¹(α; k), upper = Gamma⁻¹(1 − α; k + 1), with α = 1 − confidence.
 * (Equivalently χ²(2k)/2 and χ²(2k + 2)/2.)
 */
export function poissonBounds(count: number, confidence: number): { lower: number; upper: number } {
  if (count < 0 || !Number.isInteger(count)) throw new Error("poissonBounds: count must be a whole number");
  const alpha = 1 - confidence;
  return {
    lower: count === 0 ? 0 : gammaQuantile(count, alpha),
    upper: gammaQuantile(count + 1, confidence),
  };
}

/** Regularised incomplete beta I_x(a, b) (continued fraction, modified Lentz). */
export function regularisedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const fraction = (aa: number, bb: number, xx: number) => {
    const tiny = 1e-300;
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m < 1000; m += 1) {
      const m2 = 2 * m;
      let an = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + an * d; if (Math.abs(d) < tiny) d = tiny;
      c = 1 + an / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d; h *= d * c;
      an = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + an * d; if (Math.abs(d) < tiny) d = tiny;
      c = 1 + an / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < 1e-15) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? (front * fraction(a, b, x)) / a : 1 - (front * fraction(b, a, 1 - x)) / b;
}

/** Quantile of the beta(a, b) distribution, by bisection (deterministic). */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (regularisedBeta(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * One-sided exact (Clopper–Pearson) bounds on a proportion from successes out of n:
 * lower = Beta⁻¹(α; k, n − k + 1), upper = Beta⁻¹(1 − α; k + 1, n − k), with α = 1 − confidence.
 * Each bound holds at least the stated confidence for every n and true proportion (it is conservative).
 */
export function exactBinomialBounds(successes: number, n: number, confidence: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  if (successes < 0 || successes > n || !Number.isInteger(successes)) throw new Error("exactBinomialBounds: successes must be a whole number from 0 to n");
  const alpha = 1 - confidence;
  return {
    lower: successes === 0 ? 0 : betaQuantile(alpha, successes, n - successes + 1),
    upper: successes === n ? 1 : betaQuantile(confidence, successes + 1, n - successes),
  };
}
