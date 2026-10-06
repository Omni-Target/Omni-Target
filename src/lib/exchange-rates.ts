import { getExchangeRateCache, setExchangeRateCache } from "./db";

/**
 * USD-based fallback exchange rates (1 USD = N local units), used ONLY when both
 * the 24h DB cache and the live FX API are unavailable — so a cold cache or a
 * network blip never breaks budget math or dashboard spend conversion.
 *
 * NGN (Naira) is highly volatile; treat these as a rough floor, not a quote.
 */
export const FALLBACK_RATES: Record<string, number> = {
  USD: 1,
  GBP: 0.8,
  EUR: 0.9,
  AED: 3.67,
  NGN: 1600,
  CAD: 1.4,
  AUD: 1.5,
  GHS: 15,
  KES: 130,
  ZAR: 19,
};

/** How long a cached rate set is considered fresh (12h to stay responsive to FX swings). */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Free, no-key USD-base FX feed. */
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";

/**
 * Resolve USD-based exchange rates, preferring (in order):
 *   1. the shared DB cache, if written within the last 24h;
 *   2. a fresh pull from {@link FX_API_URL} (which also refreshes the cache);
 *   3. {@link FALLBACK_RATES}.
 *
 * Every failure path is swallowed and degrades to the next source, so callers
 * always receive a usable rate map and never throw.
 *
 * WARNING: NGN is highly volatile — the 24h cache window can introduce
 * meaningful variance in daily/monthly budget figures during rapid moves.
 */
export interface ExchangeRateSnapshot {
  rates: Record<string, number>;
  source: "live" | "cache" | "fallback" | "provided";
  fetched_at: string | null;
}

function validRates(value: unknown): value is Record<string, number> {
  return !!value && typeof value === "object" &&
    Object.values(value).every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate > 0);
}

export async function fetchExchangeRateSnapshot(): Promise<ExchangeRateSnapshot> {
  try {
    const cached = await getExchangeRateCache();
    if (cached && validRates(cached.rates) && cached.fetched_at) {
      const fetchedAt = new Date(cached.fetched_at).getTime();
      if (fetchedAt > Date.now() - CACHE_TTL_MS) {
        return { rates: cached.rates, source: "cache", fetched_at: cached.fetched_at };
      }
    }
  } catch (err) {
    console.error("Error reading exchange rates cache from database layer:", err);
  }

  // Cache miss or stale: fetch fresh and repopulate the cache.
  try {
    console.log("Fetching fresh exchange rates from API...");
    const res = await fetch(FX_API_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const json = await res.json();
    const rates = json.rates as Record<string, number>;

    if (validRates(rates)) {
      try {
        await setExchangeRateCache(rates);
      } catch (cacheErr) {
        console.error("Database write exchange rate cache error:", cacheErr);
      }
      return { rates, source: "live", fetched_at: new Date().toISOString() };
    }
  } catch (err) {
    console.error("Failed to fetch fresh exchange rates from API:", err);
  }

  return { rates: FALLBACK_RATES, source: "fallback", fetched_at: null };
}

export async function fetchExchangeRates(): Promise<Record<string, number>> {
  return (await fetchExchangeRateSnapshot()).rates;
}

/**
 * USD→`currency` multiplier (1 USD = N units of `currency`), preferring live
 * rates and falling back per-currency. Unknown currencies resolve to 1.
 */
export async function getUsdRate(currency: string): Promise<number> {
  const rates = await fetchExchangeRates();
  const rate = rates[currency] ?? FALLBACK_RATES[currency];
  if (!rate || !Number.isFinite(rate)) throw new Error(`Unsupported currency: ${currency}`);
  return rate;
}
