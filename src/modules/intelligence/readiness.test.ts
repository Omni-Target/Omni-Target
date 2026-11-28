import { describe, expect, it } from "vitest";
import { recommendProduct } from "@/modules/economics/recommend";
import { buildScenario, COMPLETE_COSTS, HEALTHY_80, type Scenario } from "@/modules/economics/__fixtures__/scenario";
import { POLICY_V3 } from "@/modules/economics/__fixtures__/policy-v3";
import { QUALITY_FIELDS, type ProductQuality, type QualityState } from "@/modules/quality/rules";
import { assessReadiness, type ReadinessInput } from "./readiness";
import type { MarketServiceability } from "./serviceability";

/** Phase 5, task 6: product readiness. ILLUSTRATIVE products. */
const LIMITS = { ad_test_limit: 1000, ad_max_loss: 600, ad_daily_limit: 50, ad_monthly_limit: 3000, purchase_event_basis: 1 };
const rec = (s: Scenario = HEALTHY_80) => {
  const built = buildScenario({ ...s, inputs: { ...COMPLETE_COSTS, ...LIMITS, ...s.inputs }, policy: POLICY_V3.settings });
  return recommendProduct({ ...built, asOf: "2026-11-24T00:00:00Z", freshness: { inventory: "2026-11-24T00:00:00Z" } });
};
const quality = (overrides: Partial<Record<(typeof QUALITY_FIELDS)[number], QualityState>> = {}): ProductQuality => ({
  calc_version: 1, counts: { present: 0, empty: 0, missing: 0, unavailable: 0, unverified: 0 },
  flags: Object.fromEntries(QUALITY_FIELDS.map((f) => [f, { state: overrides[f] ?? "present", reason: `${f} ${overrides[f] ?? "present"}` }])) as ProductQuality["flags"],
});
const SERVICED: MarketServiceability = { rules_version: 1, target_country: "NG", status: "serviced", synced_at: null, explanation: "Sold and delivered to NG.",
  checks: { market: { state: "pass", evidence: "" }, shipping: { state: "pass", evidence: "" } } };
const input = (patch: Partial<ReadinessInput> = {}): ReadinessInput => ({
  product: { product_id: 1, status: "active", online_store_url: "https://shop.example/products/board" },
  quality: quality(), market: SERVICED, recommendation: rec(), policies: [{ type: "REFUND_POLICY", title: "Refund policy" }],
  tracking: { meta_connected: true, pixel_set: true }, ...patch });

describe("product readiness", () => {
  it("READY when every check passes, with no fix to make", () => {
    const r = assessReadiness(input());
    expect(r).toMatchObject({ status: "READY", holds_budget: false });
    expect(r.checks.map((c) => [c.key, c.status])).toEqual([["economics", "pass"], ["product_page", "pass"], ["market", "pass"], ["stock", "pass"],
      ["images", "pass"], ["description", "pass"], ["compare_at_price", "pass"], ["returns", "pass"], ["tracking", "pass"]]);
    expect(r.checks.every((c) => c.fix === null)).toBe(true);
  });

  it("NOT_READY, holding any amount, when the product has no page, or its market is not served", () => {
    const unpublished = assessReadiness(input({ product: { product_id: 1, status: "active", online_store_url: null } }));
    expect(unpublished).toMatchObject({ status: "NOT_READY", holds_budget: true, explanation: "Not ready to advertise: product page." });
    expect(unpublished.checks.find((c) => c.key === "product_page")).toMatchObject({ status: "fail", blocking: true, fix: expect.stringMatching(/Online Store/) });
    const elsewhere = assessReadiness(input({ market: { ...SERVICED, status: "not_serviced", target_country: "GH", explanation: "No market contains GH." } }));
    expect(elsewhere).toMatchObject({ status: "NOT_READY", holds_budget: true });
    expect(elsewhere.checks.find((c) => c.key === "market")!.fix).toMatch(/GH/);
  });

  it("quotes the economics verdict and never makes a product more advertisable than it allows", () => {
    const losing = assessReadiness(input({ recommendation: rec({ ...HEALTHY_80, variants: [{ price: 80, cost: 70, units: 100, available: 500 }] }) }));
    expect(losing).toMatchObject({ status: "NOT_READY", holds_budget: true });
    expect(losing.checks[0]).toMatchObject({ key: "economics", status: "fail", evidence: expect.stringMatching(/DO NOT LAUNCH: NEGATIVE_CONTRIBUTION_MARGIN/) });
    const missing = assessReadiness(input({ recommendation: rec({ ...HEALTHY_80, variants: [{ price: 80, cost: null, units: 100, available: 500 }] }) }));
    expect(missing.status).toBe("NOT_READY");
    // Property: whatever else passes, a verdict other than GO or PILOT is never READY or NEEDS_ATTENTION.
    for (const cost of [70, 75, 79, null]) {
      const r = rec({ ...HEALTHY_80, variants: [{ price: 80, cost, units: 100, available: 500 }] });
      if (r.verdict !== "GO" && r.verdict !== "PILOT") expect(assessReadiness(input({ recommendation: r })).status).toBe("NOT_READY");
    }
  });

  it("NEEDS_ATTENTION for what can be improved without stopping advertising", () => {
    const r = assessReadiness(input({ quality: quality({ images: "missing", compare_at_price: "unverified" }), policies: [],
      tracking: { meta_connected: false, pixel_set: false }, recommendation: rec({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ...LIMITS, purchase_event_basis: undefined as unknown as number } }) }));
    expect(r).toMatchObject({ status: "NEEDS_ATTENTION", holds_budget: false });
    expect(r.checks.filter((c) => c.status !== "pass").map((c) => [c.key, c.status])).toEqual([["images", "attention"], ["compare_at_price", "attention"],
      ["returns", "attention"], ["tracking", "attention"]]);
    expect(r.checks.find((c) => c.key === "tracking")!.fix).toMatch(/confirm in Settings that your own pixel counts purchases/);
  });

  it("is unknown, not failed, where evidence was not read, and a merchant's own pixel is never a blocker", () => {
    const r = assessReadiness(input({ quality: null, market: null, policies: null, tracking: { meta_connected: null, pixel_set: null },
      recommendation: rec({ ...HEALTHY_80, inputs: { ...COMPLETE_COSTS, ...LIMITS, purchase_event_basis: undefined as unknown as number } }) }));
    expect(r.status).toBe("NEEDS_ATTENTION");
    expect(r.checks.filter((c) => c.status === "unknown").map((c) => c.key)).toEqual(["market", "images", "description", "compare_at_price", "returns", "tracking"]);
    expect(r.checks.some((c) => c.blocking)).toBe(false);
  });
});
