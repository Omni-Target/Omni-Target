/**
 * Live check of summary maintenance (Phase 2, task 8; decision 6) on real
 * data, after late changes reached a shop's final months (new backdated
 * orders, late refunds). On staging only.
 *
 * Snapshots the final summaries of the retained window, runs the same
 * maintenance the schedule runs (unless LIVE_MAINTAIN=0), and checks that:
 * the final rows are untouched; every window month's effective summary (final
 * plus adjustments, or the open month) equals a recomputation from the shop's
 * own orders, exported raw from Shopify (not through the import's mappers);
 * and every changed final month has adjustments. Customer counts are not
 * adjusted by design, so they are reported, not compared. Writes LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Raw = Record<string, unknown>;
const money = (value: unknown) => Math.round(Number(((value as { shopMoney?: { amount?: string } } | null)?.shopMoney?.amount) ?? 0) * 10_000);
const idOf = (value: unknown) => Number(String((value as { id?: string } | null)?.id ?? value ?? "").split("/").pop());
const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;
const scaled = (value: unknown) => Math.round(Number(value) * 10_000);
const PAGE = 1000;

interface StoreMonth { orders: number; units: number; subtotal: number; discounts: number; tax: number; shipping: number; total: number; refunded: number }
interface ProductMonth { orders: Set<number>; units: number; gross: number; discounts: number; refunded: number }
const EMPTY: StoreMonth = { orders: 0, units: 0, subtotal: 0, discounts: 0, tax: 0, shipping: 0, total: 0, refunded: 0 };
const storeOf = (r: Record<string, unknown>): StoreMonth => ({
  orders: Number(r.orders), units: Number(r.units), subtotal: scaled(r.subtotal ?? 0), discounts: scaled(r.total_discounts ?? 0), tax: scaled(r.total_tax ?? 0),
  shipping: scaled(r.total_shipping ?? 0), total: scaled(r.total_price ?? 0), refunded: scaled(r.total_refunded ?? 0),
});

describe("live summary adjustments", () => {
  it("keeps final summaries and adjusts them to the shop's own orders", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { maintainSummaries } = await import("./maintenance");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const bulk = await import("@/modules/ingestion/bulk");
    const { parseJsonl, groupUnits } = await import("@/modules/ingestion/jsonl");
    const { ordersQuery, searchFilter } = await import("@/modules/ingestion/queries");

    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).single();
    if (!shop) throw new Error("shop not modelled");
    const key = shop.shop_key as number;
    const { data: windowStartRaw } = await supabaseAdmin.rpc("shop_window_start", { p_shop_key: key });
    const windowStart = new Date(String(windowStartRaw));
    const from = windowStart.toISOString().slice(0, 10);
    const to = monthOf(new Date().toISOString());

    const paged = async <T,>(build: (lo: number, hi: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> => {
      const all: T[] = [];
      for (let lo = 0; ; lo += PAGE) {
        const { data, error } = await build(lo, lo + PAGE - 1);
        if (error) throw new Error(error.message);
        all.push(...(data ?? []));
        if ((data ?? []).length < PAGE) return all;
      }
    };
    type Row = Record<string, unknown>;
    const finalRows = async () => ({
      store: await paged<Row>((lo, hi) => supabaseAdmin.from("store_monthly_metrics").select("*").eq("shop_key", key).gte("month", from)
        .not("finalized_at", "is", null).order("month").range(lo, hi)),
      product: await paged<Row>((lo, hi) => supabaseAdmin.from("product_monthly_metrics").select("*").eq("shop_key", key).gte("month", from)
        .not("finalized_at", "is", null).order("month").order("product_shopify_id").range(lo, hi)),
    });
    type Adjustment = { id: number; month: string; reason: string; orders: number; total_price?: number; total_refunded?: number };
    const adjustmentRows = async () => ({
      store: await paged<Adjustment>((lo, hi) => supabaseAdmin.from("store_monthly_adjustments").select("id, month, reason, orders, total_price, total_refunded")
        .eq("shop_key", key).order("id").range(lo, hi)),
      product: await paged<Adjustment>((lo, hi) => supabaseAdmin.from("product_monthly_adjustments").select("id, month, reason, orders")
        .eq("shop_key", key).order("id").range(lo, hi)),
    });

    const before = await finalRows();
    const adjustmentsBefore = await adjustmentRows();
    const maintenance = process.env.LIVE_MAINTAIN === "0" ? null : await maintainSummaries({ budgetMs: 780_000 });
    const after = await finalRows();
    const adjustmentsAfter = await adjustmentRows();

    // Expected, from the shop's own orders in the window, exported raw.
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const gql: import("@/modules/ingestion/bulk").Gql = (query, variables) => shopifyGraphql(domain, access.accessToken, query, variables);
    const started = await bulk.startBulkQuery(gql, ordersQuery(searchFilter([["processed_at", ">=", windowStart]])));
    if (started.outcome !== "started") throw new Error(`not started: ${JSON.stringify(started)}`);
    let operation = await bulk.getBulkOperation(gql, started.id);
    for (let attempt = 0; operation && bulk.bulkPhase(operation).phase === "pending" && attempt < 300; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(bulk.pollDelayMs(attempt), 10_000)));
      operation = await bulk.getBulkOperation(gql, started.id);
    }
    const phase = bulk.bulkPhase(operation!);
    if (phase.phase !== "completed") throw new Error(JSON.stringify(phase));
    const stores = new Map<string, StoreMonth>();
    const products = new Map<string, ProductMonth>();
    let exported = 0;
    if (phase.url) for await (const unit of groupUnits(parseJsonl(await bulk.openBulkResult(phase.url)))) {
      exported += 1;
      const order = unit.root as Raw;
      if (order.test || order.cancelledAt) continue;
      const month = monthOf(String(order.processedAt));
      if (month > to) continue;
      const store = stores.get(month) ?? { ...EMPTY };
      store.orders += 1;
      store.subtotal += money(order.subtotalPriceSet);
      store.discounts += money(order.totalDiscountsSet);
      store.tax += money(order.totalTaxSet);
      store.shipping += money(order.totalShippingPriceSet);
      store.total += money(order.totalPriceSet);
      store.refunded += money(order.totalRefundedSet);
      for (const line of unit.children.filter((child) => String(child.id).includes("/LineItem/"))) {
        const quantity = Number(line.quantity ?? 0);
        store.units += quantity;
        if (!line.product) continue;
        const productKey = `${month}|${idOf(line.product)}`;
        const product = products.get(productKey) ?? { orders: new Set<number>(), units: 0, gross: 0, discounts: 0, refunded: 0 };
        product.orders.add(idOf(order.id));
        product.units += quantity;
        product.gross += money(line.originalUnitPriceSet) * quantity;
        product.discounts += money(line.totalDiscountSet);
        const current = line.currentQuantity === null || line.currentQuantity === undefined ? null : Number(line.currentQuantity);
        product.refunded += current === null ? 0 : Math.max(0, quantity - Math.min(current, quantity));
        products.set(productKey, product);
      }
      stores.set(month, store);
    }

    // Effective: final plus adjustments, or the open month as rebuilt.
    type StoreEffective = Row & { month: string; final: boolean; adjustments: number; customers: number; new_customers: number };
    type ProductEffective = { month: string; product_shopify_id: number; orders: number; units: number; gross_sales: number; discounts: number;
      refunded_units: number; final: boolean; adjustments: number };
    const storeEffective = await paged<StoreEffective>((lo, hi) => supabaseAdmin.rpc("store_months_effective", { p_shop_key: key, p_from: from, p_to: to }).range(lo, hi));
    const productEffective = await paged<ProductEffective>((lo, hi) => supabaseAdmin.rpc("product_months_effective", { p_shop_key: key, p_from: from, p_to: to }).range(lo, hi));

    const storeMismatches: unknown[] = [];
    const months = new Set([...stores.keys(), ...storeEffective.filter((r) => Number(r.orders) !== 0).map((r) => r.month)]);
    for (const month of [...months].sort()) {
      const expected = stores.get(month) ?? EMPTY;
      const row = storeEffective.find((r) => r.month === month);
      const actual = row && storeOf(row);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) storeMismatches.push({ month, expected, actual });
    }
    const productMismatches: unknown[] = [];
    const productKeys = new Set([...products.keys(), ...productEffective.filter((r) => r.orders !== 0 || r.units !== 0).map((r) => `${r.month}|${Number(r.product_shopify_id)}`)]);
    for (const productKey of productKeys) {
      const [month, product] = productKey.split("|");
      const e = products.get(productKey);
      const wanted = { orders: e?.orders.size ?? 0, units: e?.units ?? 0, gross: e?.gross ?? 0, discounts: e?.discounts ?? 0, refunded: e?.refunded ?? 0 };
      const row = productEffective.find((r) => r.month === month && Number(r.product_shopify_id) === Number(product));
      const actual = row && { orders: row.orders, units: row.units, gross: scaled(row.gross_sales), discounts: scaled(row.discounts), refunded: row.refunded_units };
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) productMismatches.push({ month, product, expected: wanted, actual });
    }

    // Final rows untouched; every final month whose figures changed has adjustments.
    const rowKey = (r: Row) => `${r.month}|${r.product_shopify_id ?? ""}|${r.calc_version}`;
    const changed = (a: Row[], b: Row[]) => {
      const byKey = new Map(b.map((r) => [rowKey(r), JSON.stringify(r)]));
      return a.filter((r) => byKey.get(rowKey(r)) !== JSON.stringify(r)).length;
    };
    const tally = (rows: Adjustment[]) => Object.fromEntries([...new Set(rows.map((r) => r.reason))].map((reason) => [reason, rows.filter((r) => r.reason === reason).length]));
    const seen = (rows: Adjustment[]) => new Set(rows.map((r) => r.id));
    const newStore = adjustmentsAfter.store.filter((r) => !seen(adjustmentsBefore.store).has(r.id));
    const newProduct = adjustmentsAfter.product.filter((r) => !seen(adjustmentsBefore.product).has(r.id));
    const adjustedMonths = new Set(adjustmentsAfter.store.map((r) => r.month));
    const changedWithoutAdjustments = before.store
      .filter((r) => !adjustedMonths.has(String(r.month)) && JSON.stringify(storeOf(r)) !== JSON.stringify(stores.get(String(r.month)) ?? EMPTY))
      .map((r) => String(r.month));

    const report = {
      windowStart: from, through: to, exported,
      maintenance: maintenance && { due: maintenance.due, refreshed: maintenance.refreshed, deferred: maintenance.deferred, states: maintenance.states,
        adjustments: maintenance.adjustments, failures: maintenance.failures },
      final: { storeMonths: before.store.length, productMonths: before.product.length,
        storeRowsChanged: changed(before.store, after.store), productRowsChanged: changed(before.product, after.product),
        storeRowsAfter: after.store.length, productRowsAfter: after.product.length },
      adjustments: {
        store: { total: adjustmentsAfter.store.length, new: newStore.length, byReason: tally(newStore) },
        product: { total: adjustmentsAfter.product.length, new: newProduct.length, byReason: tally(newProduct) },
        storeByMonth: newStore.map((r) => ({ month: r.month, reason: r.reason, orders: r.orders, total: Number(r.total_price), refunded: Number(r.total_refunded) })),
      },
      changedWithoutAdjustments, storeMonths: months.size, productMonths: productKeys.size,
      storeMismatches, productMismatches: productMismatches.slice(0, 10), productMismatchCount: productMismatches.length,
      customersNotAdjusted: storeEffective.filter((r) => r.final && r.adjustments > 0).map((r) => ({ month: r.month, customers: r.customers, new_customers: r.new_customers })),
    };
    console.log("adjustments", JSON.stringify(report).slice(0, 4000));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(report, null, 1));

    expect(maintenance?.failures ?? []).toEqual([]);
    expect(report.final.storeRowsChanged).toBe(0);
    expect(report.final.productRowsChanged).toBe(0);
    expect(storeMismatches).toEqual([]);
    expect(productMismatches).toEqual([]);
    expect(changedWithoutAdjustments).toEqual([]);
  }, 1_800_000);
});
