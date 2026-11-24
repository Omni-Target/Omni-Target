import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEconomicsPolicy } from "./policy";
import { POLICY_V1 } from "./__fixtures__/policy-v1";

describe("economics policy (Phase 4, task 2)", () => {
  it("keeps the test fixture identical to version 1 as migration 0052 writes it", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0052_economics_inputs.sql"), "utf8");
    const insert = sql.slice(sql.indexOf("insert into public.economics_policies"));
    const settings = JSON.parse(insert.slice(insert.indexOf("'{") + 1, insert.indexOf("}'::jsonb") + 1));
    expect(settings).toEqual(POLICY_V1.settings);
  });

  it("accepts version 1 and refuses a version the database would refuse", () => {
    expect(parseEconomicsPolicy(POLICY_V1)).toEqual(POLICY_V1);
    const bad = (patch: Record<string, unknown>) => () => parseEconomicsPolicy({ ...POLICY_V1, settings: { ...POLICY_V1.settings, ...patch } });
    expect(bad({ contribution_reserve: 1 })).toThrow(/contribution_reserve/);
    expect(bad({ contribution_reserve: -0.1 })).toThrow(/contribution_reserve/);
    expect(bad({ pilot_conversions: 2.5 })).toThrow(/pilot_conversions/);
    expect(bad({ pilot_conversions: 30 })).toThrow(/test sizes/);
    expect(bad({ scale_step: 0 })).toThrow(/scale_step/);
    expect(bad({ decision_confidence: 0.4 })).toThrow(/decision_confidence/);
    expect(bad({ allow_cost_estimates: "no" })).toThrow(/allow_cost_estimates/);
    expect(bad({ default_test_days: 40 })).toThrow(/test days/);
    const missing: Record<string, unknown> = { ...POLICY_V1.settings };
    delete missing.attribution_lag_days;
    expect(() => parseEconomicsPolicy({ ...POLICY_V1, settings: missing })).toThrow(/attribution_lag_days/);
    expect(() => parseEconomicsPolicy({ ...POLICY_V1, version: 0 })).toThrow(/version/);
    expect(() => parseEconomicsPolicy(null)).toThrow(/version/);
  });
});
