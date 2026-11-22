/**
 * Live end-to-end import (Phase 2, task 6) through a running Trigger.dev
 * worker (`pnpm dev:trigger`). The import is recorded but not dispatched (a
 * failed dispatch), recovered by the reconcile job, and followed to its end.
 * Writes the shop's data into the staging mirror. Opt-in; staging only.
 * Writes its report to LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The harness's own calls retry a transient network failure; the import itself retries in the worker. */
async function retrying<T>(call: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (error) {
      if (i >= attempts || !/fetch failed|timeout|ECONNRESET/i.test(String(error))) throw error;
      await sleep(5_000 * i);
    }
  }
}

describe("live end-to-end import", () => {
  it("imports a shop, recovering a failed dispatch through reconciliation", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");

    const { shopKeyFor } = await import("./repository");
    const imports = await import("./imports");
    const { reconcileImports } = await import("./reconcile");
    const { databaseSizeBytes } = await import("@/modules/capacity/repository");
    const { supabaseAdmin } = await import("@/platform/supabase");

    const shopKey = await retrying(() => shopKeyFor(domain));
    if (shopKey === null) throw new Error("shop not modelled");
    const sizeBefore = await retrying(() => databaseSizeBytes());

    // A dispatch that never happened: the import is recorded, nothing is sent to Trigger.dev.
    // LIVE_DOMAINS (comma-separated) scopes the import, e.g. "orders,customers,returns" (0039).
    const scope = (process.env.LIVE_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean) as import("@/modules/capacity/projection").ImportDomain[];
    const requested = await retrying(() => imports.requestImport(shopKey, scope.length ? scope : null));
    expect(requested.outcome).toBe("requested");
    const importId = requested.import_id as string;
    await sleep(125_000);
    const reconcile = await retrying(() => reconcileImports());

    const started = Date.now();
    let row: Record<string, unknown> | null = null;
    while (Date.now() - started < 3_300_000) {
      const { data } = await retrying(async () => {
        const result = await supabaseAdmin.from("shop_imports").select("status, dispatch_attempts, trigger_run_id, coverage, error, started_at, finished_at").eq("id", importId).single();
        if (result.error) throw new Error(result.error.message);
        return result;
      });
      row = data;
      if (row && ["succeeded", "partial", "failed", "cancelled"].includes(String(row.status))) break;
      await sleep(15_000);
    }
    const sizeAfter = await retrying(() => databaseSizeBytes());
    const { data: reservation } = await supabaseAdmin.from("capacity_reservations")
      .select("reserved_bytes, written_bytes, release_reason, projection").order("created_at", { ascending: false }).limit(1).single();
    const counts: Record<string, number> = {};
    for (const table of ["products", "product_variants", "metafields", "inventory_locations", "inventory_levels", "customers", "orders", "order_line_items", "refunds", "returns", "product_monthly_metrics", "store_monthly_metrics", "cohort_monthly_outcomes"]) {
      const { count } = await supabaseAdmin.from(table).select("*", { count: "exact", head: true }).eq("shop_key", shopKey);
      counts[table] = count ?? 0;
    }
    const report = { importId, reconcile, import: row, sizeBefore, sizeAfter, growthBytes: sizeAfter - sizeBefore, reservation, counts, seconds: Math.round((Date.now() - started) / 1000) };
    console.log("import", JSON.stringify(report).slice(0, 2000));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(report, null, 1));
    expect(reconcile.dispatched).toBeGreaterThanOrEqual(1);
    expect(["succeeded", "partial"]).toContain(row?.status);
  });
});
