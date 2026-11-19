import { describe, expect, it, vi } from "vitest";
import { maintainSummaries, type MaintenanceDeps } from "./maintenance";
import type { DueSummaryMonth, SummaryMonthRefresh } from "./repository";

vi.mock("@/platform/supabase", () => ({ supabaseAdmin: {} }));

const due = (shop: number, month: string, reason: DueSummaryMonth["reason"] = "open"): DueSummaryMonth =>
  ({ shop_key: shop, shop_domain: `s${shop}.myshopify.com`, month, reason });

function deps(items: DueSummaryMonth[], refresh: MaintenanceDeps["refresh"], clock: number[] = []): MaintenanceDeps {
  let tick = 0;
  return { due: async () => items, refresh, now: () => clock[Math.min(tick++, clock.length - 1)] ?? 0 };
}

describe("summary maintenance (Phase 2 task 8)", () => {
  it("refreshes each due month in its own call and totals states and adjustments", async () => {
    const calls: Array<[number, string]> = [];
    const results: Record<string, SummaryMonthRefresh> = {
      "2026-01-01": { month: "2026-01-01", state: "adjusted", product_adjustments: 2, store_adjustments: 1 },
      "2026-10-01": { month: "2026-10-01", state: "open" },
      "2026-11-01": { month: "2026-11-01", state: "open" },
    };
    const report = await maintainSummaries({ budgetMs: 60_000 }, deps(
      [due(1, "2026-01-01", "changed"), due(1, "2026-10-01"), due(1, "2026-11-01")],
      async (shop, month) => { calls.push([shop, month]); return results[month]; },
    ));
    expect(calls).toEqual([[1, "2026-01-01"], [1, "2026-10-01"], [1, "2026-11-01"]]);
    expect(report).toMatchObject({ due: 3, refreshed: 3, skipped: 0, deferred: 0, states: { adjusted: 1, open: 2 }, adjustments: { product: 2, store: 1 }, failures: [] });
  });

  it("skips the rest of a failing shop's months and carries on with other shops", async () => {
    const report = await maintainSummaries({ budgetMs: 60_000 }, deps(
      [due(1, "2026-09-01"), due(1, "2026-10-01"), due(2, "2026-10-01")],
      async (shop, month) => {
        if (shop === 1) throw new Error("shop_not_ingestible");
        return { month, state: "open" };
      },
    ));
    expect(report).toMatchObject({ refreshed: 1, skipped: 1, failures: [{ shop: "s1.myshopify.com", month: "2026-09-01", error: "shop_not_ingestible" }] });
  });

  it("leaves what remains due when the time budget runs out", async () => {
    const refresh = vi.fn(async (_shop: number, month: string): Promise<SummaryMonthRefresh> => ({ month, state: "unchanged" }));
    // Started at 0; the first month starts at 10 s, the second at 70 s, past the 60 s budget.
    const report = await maintainSummaries({ budgetMs: 60_000 }, deps(
      [due(1, "2026-08-01"), due(1, "2026-09-01"), due(1, "2026-10-01")], refresh, [0, 10_000, 70_000],
    ));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ refreshed: 1, deferred: 2 });
  });
});
