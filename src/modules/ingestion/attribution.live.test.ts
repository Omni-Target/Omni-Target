/**
 * Live attribution check (Phase 3, task 8): re-reads orders through the
 * incremental sync's by-ID path (LIVE_RESYNC_ORDERS, writing to staging), then
 * compares the stored attribution with Shopify's raw customer journey for the
 * same orders, derived here independently of the mapper (host of the
 * referrer, path of the landing page, UTM source, order index, readiness).
 * Opt-in; staging only. Writes LIVE_OUT.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Raw = Record<string, unknown>;
const RAW = `query O($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id customerJourneySummary { ready customerOrderIndex
  lastVisit { referrerUrl landingPage utmParameters { source } } } } } }`;
const host = (url: unknown) => { try { return typeof url === "string" ? new URL(url).hostname.toLowerCase() : null; } catch { return null; } };
const path = (url: unknown) => { try { return typeof url === "string" ? new URL(url, "https://x.invalid").pathname : null; } catch { return null; } };

describe("live order attribution", () => {
  it("stores the customer journey's signals as Shopify gives them", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).single();
    if (!shop) throw new Error("shop not modelled");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);

    const resync = Number(process.env.LIVE_RESYNC_ORDERS ?? 0);
    let resynced: unknown = null;
    if (resync > 0) {
      const { recordSyncEvents } = await import("./sync-repository");
      const { processShopEvents } = await import("./sync");
      const { liveSyncDeps } = await import("./sync-live");
      const { data: picked } = await supabaseAdmin.from("orders").select("shopify_id").eq("shop_key", shop.shop_key).is("journey_ready", null)
        .order("processed_at", { ascending: false }).limit(resync);
      const tag = `p3-attribution-${Date.now().toString(36)}`;
      await recordSyncEvents(domain, (picked ?? []).map((o) => ({
        webhook_id: `reconcile:${tag}:orders/updated:${o.shopify_id}`, topic: "orders/updated", triggered_at: new Date().toISOString(),
        payload: { id: Number(o.shopify_id), updated_at: new Date().toISOString() },
      })));
      resynced = await processShopEvents(domain, randomUUID(), liveSyncDeps(), { budgetMs: 600_000 });
    }

    const { data: stored } = await supabaseAdmin.from("orders")
      .select("shopify_id, referrer_host, landing_path, utm_source, customer_order_index, journey_ready")
      .eq("shop_key", shop.shop_key).not("journey_ready", "is", null).limit(Number(process.env.LIVE_SAMPLE ?? 200));
    const rows = stored ?? [];
    if (!rows.length) throw new Error("no order read with attribution");
    const mismatches: string[] = [];
    let withVisit = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const slice = rows.slice(i, i + 50);
      const { nodes } = await shopifyGraphql<{ nodes: Array<Raw | null> }>(domain, access.accessToken, RAW, { ids: slice.map((o) => `gid://shopify/Order/${o.shopify_id}`) });
      slice.forEach((o, index) => {
        const journey = (nodes[index]?.customerJourneySummary ?? null) as Raw | null;
        const last = (journey?.lastVisit ?? null) as Raw | null;
        if (last) withVisit += 1;
        const want = [host(last?.referrerUrl), last?.landingPage ? path(last.landingPage) : null,
          ((last?.utmParameters as Raw | null)?.source as string | null) ?? null, journey?.customerOrderIndex ?? null, journey?.ready ?? null];
        const got = [o.referrer_host, o.landing_path, o.utm_source, o.customer_order_index, o.journey_ready];
        if (JSON.stringify(want) !== JSON.stringify(got)) mismatches.push(`order ${o.shopify_id}: shopify ${JSON.stringify(want)} stored ${JSON.stringify(got)}`);
      });
    }
    const report = { resynced, orders: rows.length, withVisit, mismatches: mismatches.slice(0, 30), mismatchCount: mismatches.length };
    const out = JSON.stringify(report, null, 2);
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, out);
    else console.log(out);
    expect(mismatches).toEqual([]);
  }, 900_000);
});
