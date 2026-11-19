/**
 * Live customer data request (Phase 2, task 9) through a running Trigger.dev
 * worker (`pnpm dev:trigger`). Records a customers/data_request for
 * LIVE_CUSTOMER_ID at LIVE_SHOP_DOMAIN as the webhook does (the event key says
 * it is a live check), dispatches the export, follows it to ready, downloads
 * the file from object storage, verifies and decrypts it, then runs the
 * maintenance task once. Staging only. Prints counts, never the customer's
 * data. The owner of the shop's workspace receives the notice email.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("live customer data request", () => {
  it("exports, delivers and maintains a data request end to end", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    const customerId = Number(process.env.LIVE_CUSTOMER_ID);
    if (!domain || !Number.isSafeInteger(customerId) || customerId <= 0) throw new Error("LIVE_SHOP_DOMAIN and LIVE_CUSTOMER_ID are required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");

    const { supabaseAdmin } = await import("@/platform/supabase");
    const { recordCustomerCompliance } = await import("@/modules/workspaces/repository");
    const { dispatchComplianceExport } = await import("@/modules/jobs/trigger");
    const { r2ExportStore } = await import("./export-store");
    const { openExport, sha256 } = await import("./export-file");
    const { runs, tasks } = await import("@trigger.dev/sdk");

    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key, shopify_shop_id").eq("myshopify_domain", domain).single();
    if (!shop) throw new Error("shop not modelled");
    const { count: heldOrders } = await supabaseAdmin.from("orders").select("*", { count: "exact", head: true })
      .eq("shop_key", shop.shop_key).eq("customer_shopify_id", customerId);

    const recorded = await recordCustomerCompliance("customers/data_request",
      { shopifyShopId: Number(shop.shopify_shop_id), domain, eventKey: `task9-live-check-${Date.now()}`, triggeredAt: new Date().toISOString() },
      { customerId, orderIds: [] });
    expect(recorded.outcome).toBe("open");
    const requestId = recorded.compliance_request_id as string;
    const runId = await dispatchComplianceExport(requestId, "live-check", 15_000);
    expect(runId).not.toBeNull();

    const started = Date.now();
    let row: Record<string, unknown> | null = null;
    while (Date.now() - started < 300_000) {
      const { data } = await supabaseAdmin.from("compliance_exports")
        .select("status, object_key, bytes, sha256, key_version, record_counts, notified_at, expires_at, dispatch_attempts, last_error")
        .eq("request_id", requestId).single();
      row = data;
      if (row && ["ready", "withdrawn", "expired"].includes(String(row.status))) break;
      await sleep(3_000);
    }
    expect(row?.status).toBe("ready");
    const exportSeconds = Math.round((Date.now() - started) / 1000);
    // The run notifies the owner after recording the file: wait for it to end before reading the result.
    for (let i = 0; i < 60; i++) {
      const run = await runs.retrieve(runId as string);
      if (["COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "CANCELED", "TIMED_OUT"].includes(run.status)) break;
      await sleep(2_000);
    }
    const { data: settled } = await supabaseAdmin.from("compliance_exports").select("notified_at").eq("request_id", requestId).single();
    row = { ...row!, notified_at: settled?.notified_at ?? null };

    const file = await r2ExportStore().get(String(row!.object_key));
    expect(file.length).toBe(Number(row!.bytes));
    expect(sha256(file)).toBe(row!.sha256);
    const document = JSON.parse(openExport(file, requestId).toString("utf8")) as {
      request: { customer_id: number }; customer: { shopify_id: number } | null; orders: Array<{ customer_shopify_id: number | null }>;
      counts: Record<string, number>;
    };
    expect(document.request.customer_id).toBe(customerId);
    expect(document.customer?.shopify_id).toBe(customerId);
    expect(document.orders).toHaveLength(heldOrders ?? -1);
    expect(document.orders.every((order) => order.customer_shopify_id === customerId)).toBe(true);
    const { data: request } = await supabaseAdmin.from("compliance_requests").select("status, resolution").eq("id", requestId).single();

    const maintenanceHandle = await tasks.trigger("compliance-maintenance", { type: "IMPERATIVE", scheduleId: "task9-live-check", timestamp: new Date(), timezone: "UTC", upcoming: [] });
    let maintenance: { status: string; output?: unknown } = { status: "PENDING" };
    for (let i = 0; i < 90; i++) {
      maintenance = await runs.retrieve(maintenanceHandle.id);
      if (["COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "CANCELED", "TIMED_OUT"].includes(maintenance.status)) break;
      await sleep(2_000);
    }

    const report = {
      requestId, runId, exportSeconds, heldOrders,
      export: { status: row!.status, bytes: row!.bytes, keyVersion: row!.key_version, counts: row!.record_counts, notified: Boolean(row!.notified_at), expiresAt: row!.expires_at },
      request, maintenance: { status: maintenance.status, output: maintenance.output },
    };
    console.log("data request", JSON.stringify(report));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(report, null, 1));
    expect(maintenance.status).toBe("COMPLETED");
  }, 600_000);
});
