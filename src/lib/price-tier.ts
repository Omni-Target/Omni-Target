/**
 * Derives a qualitative price tier for a product.
 *
 * PRIMARY — Catalog quartiles (fully data-driven, no hardcoded numbers):
 *   Sorts the store's own product prices and splits them into four equal
 *   bands (Q1 / Q2 / Q3 / Q4). A product's tier is determined purely by
 *   where it sits in that distribution. The thresholds are the store's own
 *   data — no currency assumptions, no magic constants.
 *
 * SECONDARY — AOV-relative (currency-agnostic):
 *   Used when the catalog has fewer than 4 products (not enough for a
 *   meaningful quartile split). Compares the product price to the store's
 *   average order value. Still no hardcoded currency thresholds — the only
 *   fixed values are the ratio boundaries (0.5 / 1.2), which describe
 *   relative position, not an absolute price.
 *
 * FALLBACK — null:
 *   If neither store prices nor AOV are available, we return null and the
 *   prompt simply omits the tier signal rather than inventing one.
 */

export type PriceTier = "Budget" | "Mid-range" | "Premium" | "Luxury";

/**
 * Returns the value at a given percentile in a pre-sorted numeric array.
 * Uses linear interpolation between adjacent elements.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = p * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const fraction = index - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

/**
 * Returns the price tier for a product based on the store's own price
 * distribution. No thresholds are hardcoded — they are computed from data.
 *
 * @param price         Raw product price in the store's native currency
 * @param storePrices   All product prices from the catalog (same currency)
 * @param storeAov      Optional: store's average order value (same currency),
 *                      used as a secondary method when catalog is too small
 */
export function getPriceTier(
  price: number | string | null | undefined,
  storePrices: number[],
  storeAov?: number | null
): PriceTier | null {
  const numericPrice = typeof price === "string" ? parseFloat(price) : price;
  if (!numericPrice || isNaN(numericPrice) || numericPrice <= 0) return null;

  // ── Primary: catalog-quartile classification ───────────────────────────────
  // Requires at least 4 distinct prices for quartiles to be meaningful.
  const validPrices = storePrices.filter(p => p > 0);
  if (validPrices.length >= 4) {
    const sorted = [...validPrices].sort((a, b) => a - b);
    const q1 = percentile(sorted, 0.25);
    const q2 = percentile(sorted, 0.50); // median
    const q3 = percentile(sorted, 0.75);

    if (numericPrice <= q1) return "Budget";
    if (numericPrice <= q2) return "Mid-range";
    if (numericPrice <= q3) return "Premium";
    return "Luxury";
  }

  // ── Secondary: AOV-relative ────────────────────────────────────────────────
  // The ratio boundaries (0.5 / 1.2) describe *relative position* within this
  // store's own market — not an absolute currency amount. A product at 50% of
  // AOV is entry-level for this store; one at 120%+ is a considered purchase.
  if (storeAov && storeAov > 0) {
    const ratio = numericPrice / storeAov;
    if (ratio < 0.5) return "Budget";
    if (ratio < 1.2) return "Mid-range";
    if (ratio < 2.5) return "Premium";
    return "Luxury";
  }

  // ── Fallback: insufficient data ────────────────────────────────────────────
  return null;
}

/**
 * Returns a single-sentence tone directive for the AI prompt based on tier.
 * Phrased so the model understands *how to write*, not *what price to mention*.
 */
export function getPriceTierPromptHint(tier: PriceTier): string {
  switch (tier) {
    case "Budget":
      return "This is an entry-level product for this store — write with warmth, accessibility, and everyday value. Keep it punchy and relatable.";
    case "Mid-range":
      return "This sits in the mid-range for this store — balance quality signals with approachability. Confident, not boastful.";
    case "Premium":
      return "This is a premium product for this store — write with quiet confidence. Let quality speak without overselling. Short sentences. No hype.";
    case "Luxury":
      return "This is the top tier in this store's range — restraint is the signal. Say less. Every word must earn its place. No urgency tactics, no exclamation marks.";
  }
}
