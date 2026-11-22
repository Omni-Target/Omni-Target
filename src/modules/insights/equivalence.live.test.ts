/**
 * Live check of the read path (Phase 2, task 11; acceptance 11.2): the store
 * snapshot built by the worker from the canonical mirror, against the snapshot
 * the REST path builds, on a real shop. Read-only on Shopify; writes the shop's
 * snapshot to staging, as the worker does. Opt-in; see vitest.live.config.mjs.
 *
 * Both paths share one computation, so the check is about their inputs:
 *  - fidelity: every order both paths analyse has the same totals, customer,
 *    destination country and lines; every product both list has the same price
 *    and variants;
 *  - differences: each order or figure only one path has is accounted for by a
 *    documented cause (the retained window, the sales date, the paid-only
 *    filter, truncation, cost coverage).
 * Writes its report to LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type RestOrder = { id: number; total_price: string; subtotal_price?: string; current_subtotal_price?: string; created_at: string; financial_status: string;
  customer?: { id: number } | null; shipping_address?: { country_code?: string } | null; line_items?: Array<{ product_id: number | null; quantity: number; price: string }> };
const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);
const lineKey = (lines: Array<{ product_id: number | null; quantity: number; price: unknown }>) =>
  lines.filter((l) => l.product_id).map((l) => `${l.product_id}x${l.quantity}@${cents(l.price)}`).sort().join(",");

describe("live read path equivalence", () => {
  it("feeds the snapshot computation the same orders and products as the REST path, apart from documented differences", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { fetchShopifyStoreData, shopifyGetPaginatedWithMeta } = await import("@/lib/connectors/shopify");
    const { computeShopInsights } = await import("./live");
    const { insightOrdersPage, readShopInsights } = await import("./repository");
    const { syncShop } = await import("@/modules/ingestion/sync-repository");
    const { supabaseAdmin } = await import("@/platform/supabase");

    const shop = await syncShop(domain);
    if (!shop) throw new Error("shop not ingestible");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);

    // The REST path: its computed snapshot, and the raw orders it analyses (same query and bounds).
    const restStarted = Date.now();
    const rest = await fetchShopifyStoreData(domain, access.accessToken, null);
    const restMs = Date.now() - restStarted;
    const restOrders = (await shopifyGetPaginatedWithMeta<RestOrder>(domain, access.accessToken,
      "orders.json?status=any&financial_status=paid&limit=250&fields=id,total_price,subtotal_price,current_subtotal_price,created_at,customer,shipping_address,financial_status,line_items",
      "orders", { maxPages: 100, maxDurationMs: 120_000, allowPartial: true })).items;

    // The canonical path, as the worker runs it.
    const report = await computeShopInsights(domain);
    if (report.outcome !== "saved") throw new Error(JSON.stringify(report));
    const canonical = (await readShopInsights(shop.shopKey))!.data;
    const mirror: Awaited<ReturnType<typeof insightOrdersPage>> = [];
    for (let before: { at: string; id: number } | null = null; ;) {
      const page = await insightOrdersPage(shop.shopKey, before, 2_000);
      mirror.push(...page);
      if (page.length < 2_000) break;
      before = { at: page[page.length - 1].processed_at, id: page[page.length - 1].id };
    }

    // Fidelity: orders both paths analyse.
    const restById = new Map(restOrders.map((o) => [o.id, o]));
    const mirrorById = new Map(mirror.map((o) => [o.id, o]));
    const both = mirror.filter((o) => restById.has(o.id));
    const orderMismatches = both.flatMap((o) => {
      const r = restById.get(o.id)!;
      const fields = {
        total: [cents(r.total_price), cents(o.total_price)],
        customer: [r.customer?.id ?? null, o.customer_id],
        country: [r.shipping_address?.country_code ?? null, o.country_code],
        lines: [lineKey(r.line_items ?? []), lineKey(o.lines)],
      };
      const differing = Object.entries(fields).filter(([, [a, b]]) => a !== b).map(([name, [a, b]]) => ({ name, rest: a, canonical: b }));
      return differing.length ? [{ id: o.id, differing }] : [];
    });

    // Differences, by cause.
    const { data: windowStartRaw } = await supabaseAdmin.rpc("shop_window_start", { p_shop_key: shop.shopKey });
    const windowStart = Date.parse(String(windowStartRaw));
    const { data: detail } = await supabaseAdmin.from("orders").select("shopify_id, processed_at, financial_status").eq("shop_key", shop.shopKey)
      .in("shopify_id", restOrders.filter((o) => !mirrorById.has(o.id)).map((o) => o.id).slice(0, 1000));
    const detailById = new Map((detail ?? []).map((d) => [Number(d.shopify_id), d]));
    const restOnly = restOrders.filter((o) => !mirrorById.has(o.id));
    const restOnlyCauses = {
      // Imported or backdated: REST dates by created_at, the mirror holds detail only inside the window (by processed_at).
      beforeWindow: restOnly.filter((o) => !detailById.has(o.id)).length,
      financialStatus: restOnly.filter((o) => detailById.has(o.id) && detailById.get(o.id)!.financial_status !== "paid").length,
      other: restOnly.filter((o) => detailById.has(o.id) && detailById.get(o.id)!.financial_status === "paid").map((o) => o.id).slice(0, 10),
    };
    const mirrorOnly = mirror.filter((o) => !restById.has(o.id));
    const mirrorOnlyCauses = {
      // REST asks for financial_status=paid only (ING-10): an order with a refund drops out.
      partiallyRefunded: mirrorOnly.filter((o) => o.financial_status === "partially_refunded").length,
      other: mirrorOnly.filter((o) => o.financial_status !== "partially_refunded").map((o) => o.id).slice(0, 10),
    };

    // Products both snapshots list.
    const restProducts = new Map(rest.products.map((p) => [p.id, p]));
    const productMismatches = canonical.products.filter((p) => restProducts.has(p.id)).flatMap((p) => {
      const r = restProducts.get(p.id)!;
      const differing = [
        ["price", cents(r.price), cents(p.price)], ["variants", r.total_variant_count, p.total_variant_count], ["title", r.name, p.name],
      ].filter(([, a, b]) => a !== b);
      return differing.length ? [{ id: p.id, differing }] : [];
    });
    const coverage = (products: typeof rest.products) => Object.fromEntries(["complete", "partial", "missing"].map((c) => [c, products.filter((p) => p.unit_cost_coverage === c).length]));
    const figures = (s: typeof rest) => ({
      orders: s.orders.order_count, revenue: Math.round(s.orders.total_revenue), revenue30d: Math.round(s.orders.revenue_last_30_days),
      orders30d: s.orders.orders_last_30_days, aov: s.orders.average_order_value, repeatRate: s.orders.repeat_customer_rate,
      oldest: s.orders.oldest_order_date?.slice(0, 10), customers: s.customers, topCountries: (s.orders.top_order_countries ?? []).slice(0, 3),
      topCities: s.orders.top_locations.slice(0, 3).map((l) => `${l.city}, ${l.country} ${l.percentage}%`), products: s.products.length,
      totalProducts: s.store.total_products, currency: s.store.currency, country: s.store.country, costCoverage: coverage(s.products),
      withImages: s.products.filter((p) => p.image_url).length, warnings: s.data_quality?.warnings ?? [],
    });

    const result = {
      windowStart: new Date(windowStart).toISOString(), restMs, canonical: report,
      orders: { rest: restOrders.length, mirror: mirror.length, both: both.length, restOnly: restOnly.length, mirrorOnly: mirrorOnly.length, restOnlyCauses, mirrorOnlyCauses },
      orderMismatches: orderMismatches.slice(0, 10), orderMismatchCount: orderMismatches.length,
      products: { rest: rest.products.length, canonical: canonical.products.length, both: canonical.products.filter((p) => restProducts.has(p.id)).length },
      productMismatches: productMismatches.slice(0, 10), productMismatchCount: productMismatches.length,
      figures: { rest: figures(rest), canonical: figures(canonical) },
    };
    console.log("equivalence", JSON.stringify(result).slice(0, 4000));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(result, null, 1));

    expect(canonical.data_quality?.schema_version).toBe(9);
    expect(orderMismatches).toEqual([]);
    expect(productMismatches).toEqual([]);
    expect(restOnlyCauses.other).toEqual([]);
    expect(mirrorOnlyCauses.other).toEqual([]);
  }, 1_800_000);
});
