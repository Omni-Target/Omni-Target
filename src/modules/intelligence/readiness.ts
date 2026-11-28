import type { ProductQuality } from "@/modules/quality/rules";
import type { MarketServiceability } from "./serviceability";

/**
 * Product advertising readiness (Phase 5, task 6; architecture/phase-5-intelligence.md, "Readiness"). Whether a product
 * is ready to be advertised, from what earlier phases already establish: the product page, Phase 3's data-quality
 * flags, market serviceability (task 3), the economics engine's verdict and stock facts (Phase 4), the shop's policies
 * and purchase tracking. Nothing is re-derived and nothing is guessed.
 *
 * Order of authority: the economics verdict is quoted, never restated. DO NOT LAUNCH, BLOCKED and INSUFFICIENT DATA
 * make a product NOT_READY; readiness never makes a product more advertisable than the economics allows. Only certain,
 * blocking failures (no product page, the target market not served, the economics verdict) make it NOT_READY; anything
 * else needs attention. Omnitarget cannot see a merchant's own Meta pixel, so tracking is never blocking.
 */
export const READINESS_RULES_VERSION = 1;

export type CheckStatus = "pass" | "attention" | "fail" | "unknown";
export interface ReadinessCheck { key: string; label: string; status: CheckStatus; blocking: boolean; evidence: string; fix: string | null }
export interface ProductReadiness {
  rules_version: number;
  product_id: number;
  status: "READY" | "NEEDS_ATTENTION" | "NOT_READY";
  /** True when a blocking check failed: no amount is to be shown until it is fixed. */
  holds_budget: boolean;
  checks: ReadinessCheck[];
  explanation: string;
}

/**
 * The parts of an economics recommendation readiness reads. Declared here rather than imported, so the intelligence
 * module stays outside the economics engine (src/platform/boundaries.test.ts); a ProductRecommendation fits it.
 */
export interface ReadinessRecommendation {
  verdict: "GO" | "PILOT" | "DO_NOT_LAUNCH" | "INSUFFICIENT_DATA" | "BLOCKED";
  reasons: string[];
  notes: string[];
  economics: { purchase_event_basis?: "placed" | "paid" | "unconfirmed" };
  budget: { inventory: { units_for_ads: number | null } | null };
}

export interface ReadinessInput {
  product: { product_id: number; status: string | null; online_store_url: string | null };
  /** Phase 3 data-quality flags; null when not read. */
  quality: ProductQuality | null;
  market: MarketServiceability | null;
  recommendation: ReadinessRecommendation;
  /** The shop's published policies (titles or types), as stored by the shop-context sync. */
  policies: Array<{ type: string; title: string }> | null;
  /** Omnitarget's Meta connection for the shop: a pixel for the Conversions API, or null when not known. */
  tracking: { meta_connected: boolean | null; pixel_set: boolean | null };
}

const check = (key: string, label: string, status: CheckStatus, evidence: string, fix: string | null = null, blocking = false): ReadinessCheck =>
  ({ key, label, status, blocking: blocking && status === "fail", evidence, fix: status === "pass" ? null : fix });

export function assessReadiness(input: ReadinessInput): ProductReadiness {
  const { product, quality, market, recommendation: rec } = input;
  const checks: ReadinessCheck[] = [];
  const flag = (field: keyof ProductQuality["flags"]) => quality?.flags[field] ?? null;

  // 1. The economics engine's verdict, quoted.
  const verdict = rec.verdict;
  checks.push(verdict === "GO" || verdict === "PILOT"
    ? check("economics", "Economics", "pass", `The economics engine allows ${verdict === "GO" ? "a controlled test" : "a pilot"}.`)
    : check("economics", "Economics", "fail", `The economics engine says ${verdict.replace(/_/g, " ")}: ${rec.reasons.join(", ") || "see the economics"}.`,
      "Resolve the reasons the economics engine gives; readiness cannot override them.", true));

  // 2. A product page to send people to.
  const active = (product.status ?? "").toLowerCase() === "active";
  checks.push(active && product.online_store_url
    ? check("product_page", "Product page", "pass", "Active and published to the online store.")
    : check("product_page", "Product page", "fail", active ? "The product is active but not published to the online store, so an ad has no page to open." : "The product is not active in Shopify.",
      "Publish the product to the Online Store sales channel.", true));

  // 3. Can it be sold and delivered where it will be advertised?
  checks.push(!market ? check("market", "Sells and ships to the target country", "unknown", "Market and shipping were not assessed.", "Refresh the shop's settings from Shopify.")
    : market.status === "serviced" ? check("market", "Sells and ships to the target country", "pass", market.explanation)
    : market.status === "not_serviced" ? check("market", "Sells and ships to the target country", "fail", market.explanation,
      `Add ${market.target_country ?? "the country"} to an active Shopify market and a shipping zone with rates.`, true)
    : check("market", "Sells and ships to the target country", "unknown", market.explanation, "Check the shipping profile that holds this product."));

  // 4. Stock, from the economics engine's own facts.
  const inv = rec.budget.inventory;
  checks.push(rec.reasons.includes("OUT_OF_STOCK") ? check("stock", "Stock", "fail", "No stock is available at locations that ship online orders.", "Restock before advertising.", true)
    : rec.notes.includes("INVENTORY_LIMITED") ? check("stock", "Stock", "attention", `Stock limits the test: ${inv?.units_for_ads ?? 0} units for advertising after expected organic sales.`, "Restock to allow a full test.")
    : rec.notes.includes("INVENTORY_STALE") ? check("stock", "Stock", "attention", "Stock levels were not read recently.", "Refresh inventory from Shopify.")
    : check("stock", "Stock", "pass", inv ? `${inv.units_for_ads} units for advertising after expected organic sales.` : "Stock is not tracked for this product."));

  // 5–7. What the ad and the page show (Phase 3 quality flags).
  const content = (field: "images" | "description" | "compare_at_price", label: string, fix: string) => {
    const f = flag(field);
    if (!f) return check(field, label, "unknown", "Product data quality was not read.", "Refresh the product from Shopify.");
    if (f.state === "present" || f.state === "empty") return check(field, label, "pass", f.reason);
    return check(field, label, f.state === "unavailable" ? "unknown" : "attention", f.reason, fix);
  };
  checks.push(content("images", "Images", "Add product images: an ad's creative usually starts from them."));
  checks.push(content("description", "Description", "Add a product description, so the page answers buyers' questions."));
  checks.push(content("compare_at_price", "Price shown", "Correct the compare-at price: it should be above the price, or removed."));

  // 8. Returns: the product's eligibility and a published refund policy.
  const policy = input.policies?.some((p) => /refund|return/i.test(`${p.type} ${p.title}`)) ?? null;
  const returns = flag("return_eligibility");
  checks.push(policy === null ? check("returns", "Refund policy", "unknown", "The shop's policies were not read.", "Refresh the shop's settings from Shopify.")
    : !policy ? check("returns", "Refund policy", "attention", "No refund or return policy is published.", "Publish a refund policy: buyers and Meta's ad review look for one.")
    : check("returns", "Refund policy", returns && returns.state === "unverified" ? "attention" : "pass",
      returns && returns.state === "unverified" ? `A refund policy is published; ${returns.reason}` : "A refund policy is published.", "Check the product's return terms."));

  // 9. Purchase tracking: what Omnitarget can see, and what the merchant has confirmed.
  const basis = rec.economics.purchase_event_basis;
  const t = input.tracking;
  checks.push(t.meta_connected && t.pixel_set ? check("tracking", "Purchase tracking", basis === "unconfirmed" ? "attention" : "pass",
      basis === "unconfirmed" ? "Omnitarget sends paid purchases to Meta; how Meta counts purchases is not confirmed, so the lower break-even is used."
        : "Omnitarget sends paid purchases to Meta through the Conversions API.", "Confirm in Settings when Meta counts a purchase.")
    : basis && basis !== "unconfirmed" ? check("tracking", "Purchase tracking", "pass", `The merchant confirms Meta counts a purchase when it is ${basis}.`)
    : check("tracking", "Purchase tracking", t.meta_connected === null ? "unknown" : "attention",
      "Omnitarget cannot see a Meta pixel or Conversions API connection for this shop.", "Connect Meta in Omnitarget, or confirm in Settings that your own pixel counts purchases."));

  const blocking = checks.filter((c) => c.blocking);
  const open = checks.filter((c) => c.status !== "pass");
  const status = blocking.length ? "NOT_READY" : open.length ? "NEEDS_ATTENTION" : "READY";
  return {
    rules_version: READINESS_RULES_VERSION, product_id: product.product_id, status, holds_budget: blocking.length > 0, checks,
    explanation: status === "READY" ? "Ready to advertise: every check passes."
      : status === "NOT_READY" ? `Not ready to advertise: ${blocking.map((c) => c.label.toLowerCase()).join(", ")}.`
      : `Ready to advertise, with ${open.length} thing(s) to improve: ${open.map((c) => c.label.toLowerCase()).join(", ")}.`,
  };
}
