/**
 * Live repair of a missed webhook (Phase 2, task 10) through a running
 * Trigger.dev worker (`pnpm dev:trigger`). On staging only: deletes the
 * shop's most recently updated order from the mirror (a webhook that never
 * arrived), moves the orders watermark to just before it, runs the reconcile,
 * dispatches the sync worker, and checks that the order is back as Shopify
 * has it. Writes its report to LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("live incremental sync", () => {
  it("repairs a missed order webhook through the reconcile and the worker", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { reconcileShopUpdates } = await import("./sync");
    const { liveReconcileDeps } = await import("./sync-live");
    const repo = await import("./sync-repository");
    const { dispatchShopSync } = await import("@/modules/jobs/trigger");
    const { runs } = await import("@trigger.dev/sdk");

    const shop = await repo.syncShop(domain);
    if (!shop) throw new Error("shop not ingestible");
    const { data: newest } = await supabaseAdmin.from("orders").select("shopify_id, shopify_updated_at")
      .eq("shop_key", shop.shopKey).not("shopify_updated_at", "is", null).order("shopify_updated_at", { ascending: false }).limit(1).single();
    if (!newest) throw new Error("no order to remove");
    const { count: lines } = await supabaseAdmin.from("order_line_items").select("*", { count: "exact", head: true }).eq("shop_key", shop.shopKey).eq("order_shopify_id", newest.shopify_id);

    // The webhook that never arrived: the order is missing from the mirror.
    const { error: deleteError } = await supabaseAdmin.from("orders").delete().eq("shop_key", shop.shopKey).eq("shopify_id", newest.shopify_id);
    if (deleteError) throw new Error(deleteError.message);
    const just = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
    await repo.saveSyncWatermark(shop.shopKey, "orders", just(newest.shopify_updated_at as string, 3_600_000 - 60_000));
    await repo.saveSyncWatermark(shop.shopKey, "catalog", new Date().toISOString());
    await repo.saveSyncWatermark(shop.shopKey, "customers", new Date().toISOString());

    const reconciled = await reconcileShopUpdates(domain, liveReconcileDeps());
    const runId = await dispatchShopSync(domain, `live-${Date.now()}`, 15_000);
    expect(runId).not.toBeNull();
    let run: { status: string; output?: unknown } = { status: "PENDING" };
    for (let i = 0; i < 120; i++) {
      run = await runs.retrieve(runId as string);
      if (["COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "CANCELED", "TIMED_OUT"].includes(run.status)) break;
      await sleep(3_000);
    }
    const { data: back } = await supabaseAdmin.from("orders").select("shopify_id, shopify_updated_at").eq("shop_key", shop.shopKey).eq("shopify_id", newest.shopify_id).maybeSingle();
    const { count: linesBack } = await supabaseAdmin.from("order_line_items").select("*", { count: "exact", head: true }).eq("shop_key", shop.shopKey).eq("order_shopify_id", newest.shopify_id);
    const { data: inbox } = await supabaseAdmin.from("webhook_events").select("status").eq("shop_key", shop.shopKey);
    const statuses = (inbox ?? []).reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});

    const report = { order: newest.shopify_id, reconciled, run: { status: run.status, output: run.output }, restored: Boolean(back), lines, linesBack, inbox: statuses };
    console.log("sync", JSON.stringify(report));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(report, null, 1));
    expect(run.status).toBe("COMPLETED");
    expect(back?.shopify_updated_at && new Date(back.shopify_updated_at).getTime()).toBe(new Date(newest.shopify_updated_at as string).getTime());
    expect(linesBack).toBe(lines);
  }, 600_000);
});
