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
export type ShopifyCreditPlan = (typeof SHOPIFY_CREDIT_PLANS)[ShopifyCreditPlanKey];
export type ShopifyChargeKind = "one_time" | "subscription";

const PLANS = Object.values(SHOPIFY_CREDIT_PLANS) as ShopifyCreditPlan[];

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
 *    of our charge names exactly (normalized for dashes/spacing/case).
 *  - Managed-pricing subscriptions are named in the Partner Dashboard; they are
 *    matched by an unambiguous plan keyword (exactly one of starter/growth/scale).
 */
export function planForShopifyCharge(name: string, kind: ShopifyChargeKind): ShopifyCreditPlan | null {
  const normalized = normalize(name);
  if (!normalized) return null;
  if (kind === "one_time") {
    return PLANS.find((plan) => normalize(plan.chargeName) === normalized) ?? null;
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
