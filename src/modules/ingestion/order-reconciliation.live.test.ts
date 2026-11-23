/**
 * Live order reconciliation (Phase 3, task 1): every order Shopify reports for
 * a shop, accounted for against the staging mirror (detailed rows inside the
 * retained window, effective monthly summaries for every month), with a
 * status and exclusion breakdown. Read-only on Shopify and on the database;
 * reads only order IDs, dates, statuses and test/cancelled flags. Opt-in; see
 * vitest.live.config.mjs. Writes the report to LIVE_OUT when set.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OrderFact } from "./order-reconciliation";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const MAX_ORDERS = Number(process.env.LIVE_MAX_ORDERS ?? 20_000);
const PAGE = `query OrdersPage($after: String) {
  orders(first: 250, after: $after, sortKey: PROCESSED_AT) {
    nodes { id processedAt createdAt cancelledAt test displayFinancialStatus }
    pageInfo { hasNextPage endCursor }
  }
}`;

describe("live order reconciliation", () => {
  it("accounts for every Shopify order in the mirror", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { reconcileOrders } = await import("./order-reconciliation");

    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).single();
    if (!shop) throw new Error("shop not modelled");
    const { data: windowStartRaw } = await supabaseAdmin.rpc("retention_window_start");
    const windowStart = new Date(String(windowStartRaw)).toISOString();
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);

    type Node = { id: string; processedAt: string | null; createdAt: string; cancelledAt: string | null; test: boolean; displayFinancialStatus: string | null };
    const shopify: OrderFact[] = [];
    let after: string | null = null;
    for (;;) {
      const page: { orders: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
        await shopifyGraphql(domain, access.accessToken, PAGE, { after });
      for (const n of page.orders.nodes) {
        shopify.push({
          id: Number(n.id.split("/").pop()), processedAt: n.processedAt ?? n.createdAt, cancelled: n.cancelledAt !== null, test: n.test,
          financialStatus: n.displayFinancialStatus ? n.displayFinancialStatus.toLowerCase() : null,
        });
      }
      if (shopify.length > MAX_ORDERS) throw new Error(`more than ${MAX_ORDERS} orders; raise LIVE_MAX_ORDERS`);
      if (!page.orders.pageInfo.hasNextPage) break;
      after = page.orders.pageInfo.endCursor;
    }

    const mirror: OrderFact[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin.from("orders").select("shopify_id, processed_at, cancelled_at, is_test, financial_status")
        .eq("shop_key", shop.shop_key).order("shopify_id").range(from, from + 999);
      if (error) throw new Error(error.message);
      mirror.push(...(data ?? []).map((r) => ({
        id: Number(r.shopify_id), processedAt: String(r.processed_at), cancelled: r.cancelled_at !== null, test: Boolean(r.is_test),
        financialStatus: (r.financial_status as string | null) ?? null,
      })));
      if ((data ?? []).length < 1000) break;
    }

    const effectiveMonths: Record<string, number> = {};
    for (const table of ["store_monthly_metrics", "store_monthly_adjustments"] as const) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabaseAdmin.from(table).select("month, orders").eq("shop_key", shop.shop_key).range(from, from + 999);
        if (error) throw new Error(`${table}: ${error.message}`);
        for (const r of data ?? []) effectiveMonths[String(r.month)] = (effectiveMonths[String(r.month)] ?? 0) + Number(r.orders);
        if ((data ?? []).length < 1000) break;
      }
    }

    const report = reconcileOrders({ windowStart, shopify, mirror, effectiveMonths });
    const summary = { ...report, missingInMirror: report.missingInMirror.slice(0, 20), extraInMirror: report.extraInMirror.slice(0, 20),
      statusMismatches: report.statusMismatches.slice(0, 20) };
    const out = JSON.stringify(summary, null, 2);
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, out);
    else console.log(out);
    expect(report.ok).toBe(true);
  }, 600_000);
});
