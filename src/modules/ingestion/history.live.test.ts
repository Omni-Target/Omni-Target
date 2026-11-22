/**
 * Live check of history beyond the retained window (Phase 2, task 7; late
 * arrivals, 0042) after an import. Read-only on Shopify. Exports the shop's
 * orders processed before the window, computes each month's store and product
 * summary from the raw order JSON (not through the import's mappers), and
 * compares with the effective summaries: the import's final summary plus the
 * adjustments late arrivals added (customer counts only where a month has no
 * adjustments, since they are not adjusted). Also checks that no order before
 * the window is held as detail, that nothing is left staged, and that each
 * history customer whose first order existed at the import has it recorded.
 * With LIVE_REPLAY_SINCE (and LIVE_REPLAY_TAG), first replays the shop's order
 * changes since then through a running worker (`pnpm dev:trigger`), which
 * writes to staging. Opt-in; see vitest.live.config.mjs. Writes LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Raw = Record<string, unknown>;
const money = (value: unknown) => Math.round(Number(((value as { shopMoney?: { amount?: string } } | null)?.shopMoney?.amount) ?? 0) * 10_000);
const idOf = (value: unknown) => Number(String((value as { id?: string } | null)?.id ?? value ?? "").split("/").pop());
const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;

interface StoreMonth { orders: number; units: number; subtotal: number; discounts: number; tax: number; shipping: number; total: number; refunded: number; customers: Set<number> }
interface ProductMonth { orders: Set<number>; units: number; gross: number; discounts: number; refunded: number }

describe("live history check", () => {
  it("matches the history summaries to the shop's own orders", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");

    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const bulk = await import("./bulk");
    const { parseJsonl, groupUnits } = await import("./jsonl");
    const { ordersQuery, searchFilter } = await import("./queries");

    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).single();
    if (!shop) throw new Error("shop not modelled");
    const { data: windowStartRaw } = await supabaseAdmin.rpc("retention_window_start");
    const windowStart = new Date(String(windowStartRaw));

    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const gql: import("./bulk").Gql = (query, variables) => shopifyGraphql(domain, access.accessToken, query, variables);
    const started = await bulk.startBulkQuery(gql, ordersQuery(searchFilter([["processed_at", "<", windowStart]])));
    if (started.outcome !== "started") throw new Error(`not started: ${JSON.stringify(started)}`);
    let operation = await bulk.getBulkOperation(gql, started.id);
    for (let attempt = 0; operation && bulk.bulkPhase(operation).phase === "pending" && attempt < 300; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(bulk.pollDelayMs(attempt), 10_000)));
      operation = await bulk.getBulkOperation(gql, started.id);
    }
    const phase = bulk.bulkPhase(operation!);
    if (phase.phase !== "completed") throw new Error(JSON.stringify(phase));

    // Expected summaries, from the raw export.
    const stores = new Map<string, StoreMonth>();
    const products = new Map<string, ProductMonth>();
    const firsts = new Map<number, string>();
    // Each customer's first history order with that order's creation time: late arrivals don't change customer facts.
    const firstsByCreation = new Map<number, { at: string; created: string }>();
    let included = 0;
    let exported = 0;
    if (phase.url) for await (const unit of groupUnits(parseJsonl(await bulk.openBulkResult(phase.url)))) {
      exported += 1;
      const order = unit.root as Raw;
      if (order.test || order.cancelledAt) continue;
      included += 1;
      const at = String(order.processedAt);
      const month = monthOf(at);
      const customer = order.customer ? idOf(order.customer) : null;
      const lines = unit.children.filter((child) => String(child.id).includes("/LineItem/"));
      const store = stores.get(month) ?? { orders: 0, units: 0, subtotal: 0, discounts: 0, tax: 0, shipping: 0, total: 0, refunded: 0, customers: new Set<number>() };
      store.orders += 1;
      store.subtotal += money(order.subtotalPriceSet);
      store.discounts += money(order.totalDiscountsSet);
      store.tax += money(order.totalTaxSet);
      store.shipping += money(order.totalShippingPriceSet);
      store.total += money(order.totalPriceSet);
      store.refunded += money(order.totalRefundedSet);
      if (customer) store.customers.add(customer);
      for (const line of lines) {
        const quantity = Number(line.quantity ?? 0);
        store.units += quantity;
        if (!line.product) continue;
        const key = `${month}|${idOf(line.product)}`;
        const product = products.get(key) ?? { orders: new Set<number>(), units: 0, gross: 0, discounts: 0, refunded: 0 };
        product.orders.add(idOf(order.id));
        product.units += quantity;
        product.gross += money(line.originalUnitPriceSet) * quantity;
        product.discounts += money(line.totalDiscountSet);
        const current = line.currentQuantity === null || line.currentQuantity === undefined ? null : Number(line.currentQuantity);
        product.refunded += current === null ? 0 : Math.max(0, quantity - Math.min(current, quantity));
        products.set(key, product);
      }
      stores.set(month, store);
      if (customer && (!firsts.has(customer) || at < firsts.get(customer)!)) firsts.set(customer, at);
      if (customer && (!firstsByCreation.has(customer) || at < firstsByCreation.get(customer)!.at)) firstsByCreation.set(customer, { at, created: String(order.createdAt) });
    }
    const newCustomers = new Map<string, number>();
    for (const [, at] of firsts) newCustomers.set(monthOf(at), (newCustomers.get(monthOf(at)) ?? 0) + 1);

    // Optionally, a replay of the shop's order changes since LIVE_REPLAY_SINCE through the running worker
    // (0042: late arrivals become adjustments to their history months).
    let replay: unknown = null;
    if (process.env.LIVE_REPLAY_SINCE) {
      const { reconcileShopUpdates } = await import("./sync");
      const { liveReconcileDeps } = await import("./sync-live");
      const { dispatchShopSync } = await import("@/modules/jobs/trigger");
      const { runs } = await import("@trigger.dev/sdk");
      const tag = process.env.LIVE_REPLAY_TAG ?? `replay-${Date.now()}`;
      const recorded = await reconcileShopUpdates(domain, liveReconcileDeps(), { replay: { since: process.env.LIVE_REPLAY_SINCE, tag, domains: ["orders"] } });
      const runId = await dispatchShopSync(domain, tag, 15_000);
      let run: { status: string; output?: unknown } = { status: "PENDING" };
      for (let i = 0; runId && i < 300; i++) {
        run = await runs.retrieve(runId);
        if (["COMPLETED", "FAILED", "CRASHED", "SYSTEM_FAILURE", "CANCELED", "TIMED_OUT"].includes(run.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      replay = { tag, recorded, run: { status: run.status, output: run.output } };
    }

    // What the summaries say: each history month's final summary plus its adjustments.
    const before = new Date(windowStart.getTime() - 86_400_000).toISOString().slice(0, 10);
    const PAGE = 1000;
    const paged = async <T,>(fn: string): Promise<T[]> => {
      const all: T[] = [];
      for (let lo = 0; ; lo += PAGE) {
        const { data, error } = await supabaseAdmin.rpc(fn, { p_shop_key: shop.shop_key, p_from: "2000-01-01", p_to: before }).range(lo, lo + PAGE - 1);
        if (error) throw new Error(error.message);
        all.push(...((data ?? []) as T[]));
        if ((data ?? []).length < PAGE) return all;
      }
    };
    type Effective = Record<string, unknown> & { month: string; final: boolean; adjustments: number };
    const storeRows = await paged<Effective>("store_months_effective");
    const productRows = await paged<Effective & { product_shopify_id: number }>("product_months_effective");
    const scaled = (value: unknown) => Math.round(Number(value) * 10_000);

    // Customer counts are not adjusted (0036, 0042): compared only for months without adjustments.
    const storeMismatches: unknown[] = [];
    const customersNotAdjusted: unknown[] = [];
    for (const [month, expected] of stores) {
      const row = storeRows.find((r) => r.month === month);
      const adjusted = Boolean(row && row.adjustments > 0);
      const actual = row && {
        orders: row.orders, units: row.units, subtotal: scaled(row.subtotal), discounts: scaled(row.total_discounts), tax: scaled(row.total_tax),
        shipping: scaled(row.total_shipping), total: scaled(row.total_price), refunded: scaled(row.total_refunded),
        ...(adjusted ? {} : { customers: row.customers, new_customers: row.new_customers }), final: row.final,
      };
      const { customers, ...sums } = expected;
      const wanted = { ...sums, ...(adjusted ? {} : { customers: customers.size, new_customers: newCustomers.get(month) ?? 0 }), final: true };
      if (adjusted) customersNotAdjusted.push({ month, adjustments: row!.adjustments, customers: row!.customers, shopifyCustomers: customers.size });
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) storeMismatches.push({ month, expected: wanted, actual });
    }
    const productMismatches: unknown[] = [];
    for (const [key, expected] of products) {
      const [month, product] = key.split("|");
      const row = productRows.find((r) => r.month === month && Number(r.product_shopify_id) === Number(product));
      const actual = row && { orders: row.orders, units: row.units, gross: scaled(row.gross_sales), discounts: scaled(row.discounts), refunded: row.refunded_units, final: row.final };
      const wanted = { orders: expected.orders.size, units: expected.units, gross: expected.gross, discounts: expected.discounts, refunded: expected.refunded, final: true };
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) productMismatches.push({ month, product, expected: wanted, actual });
    }

    const { count: detailBefore } = await supabaseAdmin.from("orders").select("*", { count: "exact", head: true })
      .eq("shop_key", shop.shop_key).lt("processed_at", windowStart.toISOString());
    // Staging is not readable by service_role (0034); the import's own record says what it staged and discarded.
    const { data: lastImport } = await supabaseAdmin.from("shop_imports").select("coverage, started_at").eq("shop_id", (await supabaseAdmin.from("shops").select("id").eq("shop_key", shop.shop_key).single()).data!.id)
      .in("status", ["succeeded", "partial"]).order("finished_at", { ascending: false }).limit(1).single();
    const historyWritten = ((lastImport?.coverage as { domains?: { history?: { written?: Record<string, number> } } } | null)?.domains?.history?.written) ?? {};
    const staged = (historyWritten.orders ?? 0) + (historyWritten.lines ?? 0) - (historyWritten.discarded ?? 0);
    // The import staged each customer's first history order; checked for customers whose first order existed then.
    const importStarted = Date.parse(String(lastImport?.started_at));
    const historyCustomers = [...firstsByCreation.entries()].filter(([, f]) => Date.parse(f.created) < importStarted).map(([id]) => id);
    const { data: customerRows } = await supabaseAdmin.from("customers").select("shopify_id, history_first_order_at")
      .eq("shop_key", shop.shop_key).in("shopify_id", historyCustomers.length ? historyCustomers : [0]);
    const missingHistoryFirst = (customerRows ?? []).filter((c) => !c.history_first_order_at
      || new Date(c.history_first_order_at).getTime() !== new Date(firsts.get(Number(c.shopify_id))!).getTime()).length;

    const report = {
      windowStart: windowStart.toISOString(), exported, included, months: stores.size, productMonths: products.size, replay,
      summaries: { storeMonths: storeRows.length, productMonths: productRows.length,
        adjustedStoreMonths: storeRows.filter((r) => r.adjustments > 0).length, adjustedProductMonths: productRows.filter((r) => r.adjustments > 0).length },
      storeMismatches, productMismatches: productMismatches.slice(0, 10), productMismatchCount: productMismatches.length, customersNotAdjusted,
      detailOrdersBeforeWindow: detailBefore, stagedRows: staged,
      historyCustomers: historyCustomers.length, historyCustomersWithRow: customerRows?.length ?? 0, missingHistoryFirst,
      totals: { orders: [...stores.values()].reduce((n, s) => n + s.orders, 0), revenue: [...stores.values()].reduce((n, s) => n + s.total, 0) / 10_000 },
    };
    console.log("history", JSON.stringify(report).slice(0, 3000));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(report, null, 1));
    expect(storeMismatches).toEqual([]);
    expect(productMismatches).toEqual([]);
    expect(storeRows.length).toBe(stores.size);
    expect(productRows.length).toBe(products.size);
    expect(detailBefore).toBe(0);
    expect(staged).toBe(0);
    expect(missingHistoryFirst).toBe(0);
  }, 900_000);
});
