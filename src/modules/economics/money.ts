/**
 * Money in a currency's minor unit (Phase 4). Amounts are carried as whole
 * minor units (cents, kobo, yen), so sums are exact. Rounding follows one
 * rule: costs and reductions round up, revenue, ceilings and budgets round
 * down. Rounding can therefore never raise a ceiling or a budget.
 */
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** ISO 4217 minor-unit exponent (2 unless listed). */
export function minorUnitExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/** Tolerance in minor units: absorbs binary floating-point error, never a real fraction of a minor unit. */
const EPSILON = 1e-6;

export interface Money {
  currency: string;
  exponent: number;
  scale: number;
  /** Whole minor units, rounded down (revenue, ceilings, budgets). */
  down(major: number): number;
  /** Whole minor units, rounded up (costs, reductions). */
  up(major: number): number;
  /** Minor units back to major units. */
  major(minor: number): number;
}

export function money(currency: string): Money {
  const exponent = minorUnitExponent(currency);
  const scale = 10 ** exponent;
  return {
    currency, exponent, scale,
    // `+ 0` turns −0 (Math.ceil of a value just below zero) into 0.
    down: (major) => Math.floor(major * scale + EPSILON) + 0,
    up: (major) => Math.ceil(major * scale - EPSILON) + 0,
    major: (minor) => minor / scale,
  };
}

/** A ratio kept to six decimal places. */
export const rate6 = (value: number) => Math.round(value * 1e6) / 1e6;
