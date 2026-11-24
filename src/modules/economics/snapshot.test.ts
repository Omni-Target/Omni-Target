import { describe, expect, it } from "vitest";
import { describeBriefEconomics, formatAmount, parseBriefEconomics } from "@/lib/brief-economics";
import { budgetPlanTextLines } from "@/lib/campaigns/brief";
import { computeBudgetPlan } from "@/lib/budget-plan";
import { recommendProduct, type AcquisitionEvidence } from "./recommend";
import { toBriefEconomics, unavailableEconomics } from "./snapshot";
import { buildScenario, HEALTHY_80, type Scenario } from "./__fixtures__/scenario";

/** Phase 4, task 8: the brief's snapshot and its only wording. ILLUSTRATIVE products; every figure is the engine's. */
const META = { runId: "run-1", policyVersion: 1, computedAt: "2026-11-24T00:00:00Z" };
const snapshot = (s: Scenario, acquisition: AcquisitionEvidence | null = null, limits: Scenario["inputs"] = { ad_test_limit: 1000, ad_max_loss: 600 }) => {
  const built = buildScenario({ ...s, inputs: { ...s.inputs, ...limits } });
  return toBriefEconomics(recommendProduct({ ...built, asOf: META.computedAt, freshness: built.evidence.freshness, acquisition }), META);
};
const proven: AcquisitionEvidence = { matured_conversions: 40, matured_spend: 680, cpa: 17, cpa_lower: 13.8, cpa_upper: 21.3, immature_days: 0 };

describe("the brief's economics snapshot", () => {
  it("copies the engine's figures, verdict, reasons with their text, and budget", () => {
    const e = snapshot(HEALTHY_80, proven);
    expect(e).toMatchObject({ version: 1, status: "computed", run_id: "run-1", product_id: 1, calc_version: "econ-1.0.0", policy_version: 1,
      currency: "USD", verdict: "GO", unit: { net_revenue: 72, contribution: 30, break_even_cpa: 30, target_cpa: 21, maximum_viable_cpa: 26.11 },
      budget: { status: "recommended", kind: "controlled_test", test_budget: 420, daily_budget: 30, test_days: 14, max_experimental_loss: 600, binding: "policy" } });
    expect(e.lines!.find((l) => l.key === "product_cost")).toEqual({ key: "product_cost", label: "Product cost (unit cost)", amount: 30, source: "observed" });
    expect(e.notes!.map((n) => n.code)).toContain("POLICY_LIMIT_BINDING");
    expect(e.notes!.every((n) => n.text.length > 10)).toBe(true);
    // What is stored parses back to itself: nothing is lost or invented.
    expect(parseBriefEconomics(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("is strict about what it renders", () => {
    const e = snapshot(HEALTHY_80, proven);
    expect(parseBriefEconomics(null)).toBeNull();
    expect(parseBriefEconomics({ ...e, version: 2 })).toBeNull();
    expect(parseBriefEconomics({ ...e, verdict: "MAYBE" })).toBeNull();
    expect(parseBriefEconomics({ ...e, currency: "dollars" })).toBeNull();
    expect(parseBriefEconomics({ ...e, budget: { ...e.budget, status: "unlimited" } })).toBeNull();
    const tampered = parseBriefEconomics({ ...e, unit: { ...e.unit, target_cpa: "21" }, reasons: [{ code: "<script>", text: "x" }] })!;
    expect(tampered.unit!.target_cpa).toBeNull();
    expect(tampered.reasons).toEqual([]);
    expect(parseBriefEconomics({ version: 1, status: "unavailable", unavailable_reason: "nonsense" })).toEqual(unavailableEconomics("engine_error"));
  });
});

describe("the only wording for a brief's budget", () => {
  it("GO: a controlled test within the merchant's limits, with the per-order figures", () => {
    const t = describeBriefEconomics(snapshot(HEALTHY_80, proven));
    expect(t).toMatchObject({ verdict: "GO", heading: "Controlled test: up to $420 over 14 days", daily: "Up to $30/day", total: "$420 maximum over 14 days" });
    expect(t.explanation).toMatch(/about 20 sales at the \$21 target cost per sale.*Stop if losses reach \$600.*not a forecast/);
    expect(t.figures).toEqual(expect.arrayContaining([["Net revenue per order", "$72"], ["Contribution before advertising", "$30"],
      ["Break-even cost per sale", "$30"], ["Target cost per sale", "$21"], ["Break-even ROAS", "2.40"], ["Contribution margin", "41.7%"]]));
  });

  it("names why nothing is recommended, and shows no invented amount", () => {
    const missing = describeBriefEconomics(snapshot({ ...HEALTHY_80, variants: [{ price: 80, cost: null, units: 100, available: 500 }] }));
    expect(missing).toMatchObject({ verdict: "INSUFFICIENT_DATA", daily: "Withheld", total: "Withheld" });
    expect(missing.explanation).toMatch(/No unit cost is recorded in Shopify.*No figure is estimated/);
    const unviable = describeBriefEconomics(snapshot({ ...HEALTHY_80, variants: [{ price: 80, cost: 70, units: 100, available: 500 }] }));
    expect(unviable).toMatchObject({ verdict: "DO_NOT_LAUNCH", heading: "Do not launch: no budget", daily: "$0", total: "$0" });
    const noLimit = describeBriefEconomics(snapshot(HEALTHY_80, null, {}));
    expect(noLimit).toMatchObject({ heading: "Set your spending limit to get a budget", daily: "Not set" });
    expect(describeBriefEconomics(unavailableEconomics("product_not_identified"))).toMatchObject({ daily: "Not available", verdict: null });
  });

  it("writes the same figures into the plain-text export", () => {
    const lines = budgetPlanTextLines(computeBudgetPlan({ currency: "USD" }), snapshot(HEALTHY_80, proven));
    expect(lines).toEqual(expect.arrayContaining(["Verdict: GO: a controlled test is justified", "Break-even cost per sale: $30",
      "Daily budget: Up to $30/day", "Test budget: $420 maximum over 14 days"]));
  });

  it("shows money in the currency's own minor unit and never rounds a limit up", () => {
    expect(formatAmount(20_999.7, "NGN")).toBe("₦20,999.70");
    expect(formatAmount(10.719, "USD")).toBe("$10.71");
    expect(formatAmount(1500.9, "JPY")).toMatch(/1,500$/);
  });
});
