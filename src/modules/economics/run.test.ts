import { describe, expect, it } from "vitest";
import { recordedRows, runEconomics, runSummary } from "./run";
import { buildScenario, HEALTHY_80 } from "./__fixtures__/scenario";

describe("recording a run (Phase 4, task 6)", () => {
  it("maps each recommendation to the stored row, with the full arguments and output", () => {
    const ok = buildScenario({ ...HEALTHY_80, inputs: { ...HEALTHY_80.inputs, ad_test_limit: 500 } });
    const missing = buildScenario({ ...HEALTHY_80, productId: 2, variants: [{ price: 80, cost: null, units: 100, available: 500 }] });
    const result = runEconomics({ evidence: ok.evidence, products: [{ product: ok.product, inputs: ok.inputs }, { product: missing.product, inputs: missing.inputs }],
      policy: ok.policy, commitments: [], monthlyLimit: null });
    const rows = recordedRows(result);
    expect(rows.map((r) => [r.product_id, r.verdict, r.budget_status, r.test_budget, r.daily_budget, r.target_cpa])).toEqual([
      [1, "PILOT", "recommended", 210, 15, 21],
      [2, "INSUFFICIENT_DATA", "withheld", null, null, null],
    ]);
    expect(rows[0].inputs.product.product_id).toBe(1);
    expect(rows[1].reasons).toEqual(["UNIT_COST_MISSING"]);
    expect(runSummary(result)).toEqual({ verdicts: { PILOT: 1, INSUFFICIENT_DATA: 1 }, recommended_total: 210 });
    // Each stored row stays well within the database's size checks (inputs ≤ 256 KB, outputs ≤ 128 KB).
    for (const row of rows) {
      expect(JSON.stringify(row.inputs).length).toBeLessThan(20_000);
      expect(JSON.stringify(row.outputs).length).toBeLessThan(20_000);
    }
  });
});
