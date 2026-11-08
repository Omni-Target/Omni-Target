/**
 * Shopify credit-pack catalogue and crediting rules (Phase S0.6 — SEC-12).
 *
 * Single source of truth for the charges the app creates and for deciding
 * whether a Shopify charge may grant credits. Previously the create route,
 * the billing callback and App Store reconciliation each carried their own
 * copy, and none checked Shopify's `test` flag — so free test charges (e.g.
 * on development stores) were credited as paid packs.
 */
export const SHOPIFY_CREDIT_PLANS = {
  starter: { key: "starter", label: "Starter", credits: 3, chargeName: "Starter Pack – 3 Credits", price: "9.00" },
  growth: { key: "growth", label: "Growth", credits: 10, chargeName: "Growth Pack – 10 Credits", price: "25.00" },
  scale: { key: "scale", label: "Scale", credits: 30, chargeName: "Scale Pack – 30 Credits", price: "59.00" },
} as const;

export type ShopifyCreditPlanKey = keyof typeof SHOPIFY_CREDIT_PLANS;
export type ShopifyChargeKind = "one_time" | "subscription";

/** A plan a Shopify charge can be credited as (current catalogue or legacy name). */
export interface ShopifyCreditPlan {
  key: ShopifyCreditPlanKey;
  label: string;
  credits: number;
  chargeName: string;
  price: string;
  /** True for a pack that is no longer sold but must still be honoured. */
  legacy?: boolean;
}

/**
 * One-time packs sold under these names from 2026-05-28 until commit a9b93e4
 * (2026-09-03) renamed and re-priced them. A purchase is credited with what
 * the merchant bought, so these names keep their original credit amounts.
 * They are never used to create new charges. ("Scale Pack – 30 Credits" kept
 * its name and credit amount, so it needs no legacy entry.)
 */
export const LEGACY_SHOPIFY_ONE_TIME_PLANS: readonly ShopifyCreditPlan[] = [
  { key: "starter", label: "Starter", credits: 5, chargeName: "Starter Pack – 5 Credits", price: "39.00", legacy: true },
  { key: "growth", label: "Growth", credits: 15, chargeName: "Growth Pack – 15 Credits", price: "99.00", legacy: true },
];

const PLANS: readonly ShopifyCreditPlan[] = Object.values(SHOPIFY_CREDIT_PLANS);

function normalize(value: string): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Map a Shopify charge to a credit plan.
 *  - One-time purchases are created by this app, so their name must match one
 *    of our current or legacy charge names exactly (normalized for
 *    dashes/spacing/case); legacy names credit their original amounts.
 *  - Managed-pricing subscriptions are named in the Partner Dashboard; they are
 *    matched by an unambiguous plan keyword (exactly one of starter/growth/scale).
 */
export function planForShopifyCharge(name: string, kind: ShopifyChargeKind): ShopifyCreditPlan | null {
  const normalized = normalize(name);
  if (!normalized) return null;
  if (kind === "one_time") {
    return (
      [...PLANS, ...LEGACY_SHOPIFY_ONE_TIME_PLANS].find((plan) => normalize(plan.chargeName) === normalized) ?? null
    );
  }
  const words = new Set(normalized.split(" "));
  const matches = PLANS.filter((plan) => words.has(plan.key));
  return matches.length === 1 ? matches[0] : null;
}

/** Whether test charges may grant credits in this environment (never in production unless explicitly enabled). */
export function testChargesAllowed(env: { NODE_ENV?: string; SHOPIFY_TEST_BILLING?: string } = process.env): boolean {
  return env.SHOPIFY_TEST_BILLING === "true" || env.NODE_ENV !== "production";
}

/** A charge grants credits only when ACTIVE and, if it is a test charge, only where test billing is allowed. */
export function isCreditableCharge(
  charge: { status?: string | null; test?: boolean | null },
  env: { NODE_ENV?: string; SHOPIFY_TEST_BILLING?: string } = process.env,
): boolean {
  if (charge.status !== "ACTIVE") return false;
  if (charge.test === true && !testChargesAllowed(env)) return false;
  return true;
}
