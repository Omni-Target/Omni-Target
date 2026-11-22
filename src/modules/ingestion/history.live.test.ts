/**
 * Live check of history beyond the retained window (Phase 2, task 7) after an
 * import. Read-only on Shopify and staging. Exports the shop's orders
 * processed before the window, computes each month's store and product
 * summary from the raw order JSON (not through the import's mappers), and
 * compares with the summaries the import wrote. Also checks that no order
 * before the window is held as detail, that nothing is left staged, and that
 * every history customer with a customer row has their history first order.
 * Opt-in; see vitest.live.config.mjs. Writes its report to LIVE_OUT.
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
    }
    const newCustomers = new Map<string, number>();
    for (const [, at] of firsts) newCustomers.set(monthOf(at), (newCustomers.get(monthOf(at)) ?? 0) + 1);

    // What the import wrote.
    const before = windowStart.toISOString().slice(0, 10);
    const { data: storeRows } = await supabaseAdmin.from("store_monthly_metrics")
      .select("month, orders, units, subtotal, total_discounts, total_tax, total_shipping, total_price, total_refunded, customers, new_customers, finalized_at")
      .eq("shop_key", shop.shop_key).lt("month", before).order("month");
    const { data: productRows } = await supabaseAdmin.from("product_monthly_metrics")
      .select("month, product_shopify_id, orders, units, gross_sales, discounts, refunded_units, finalized_at")
      .eq("shop_key", shop.shop_key).lt("month", before).limit(10_000);
    const scaled = (value: unknown) => Math.round(Number(value) * 10_000);

    const storeMismatches: unknown[] = [];
    for (const [month, expected] of stores) {
      const row = (storeRows ?? []).find((r) => r.month === month);
      const actual = row && {
        orders: row.orders, units: row.units, subtotal: scaled(row.subtotal), discounts: scaled(row.total_discounts), tax: scaled(row.total_tax),
        shipping: scaled(row.total_shipping), total: scaled(row.total_price), refunded: scaled(row.total_refunded), customers: row.customers,
        new_customers: row.new_customers, final: row.finalized_at !== null,
      };
      const { customers, ...sums } = expected;
      const wanted = { ...sums, customers: customers.size, new_customers: newCustomers.get(month) ?? 0, final: true };
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) storeMismatches.push({ month, expected: wanted, actual });
    }
    const productMismatches: unknown[] = [];
    for (const [key, expected] of products) {
      const [month, product] = key.split("|");
      const row = (productRows ?? []).find((r) => r.month === month && Number(r.product_shopify_id) === Number(product));
      const actual = row && { orders: row.orders, units: row.units, gross: scaled(row.gross_sales), discounts: scaled(row.discounts), refunded: row.refunded_units, final: row.finalized_at !== null };
      const wanted = { orders: expected.orders.size, units: expected.units, gross: expected.gross, discounts: expected.discounts, refunded: expected.refunded, final: true };
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) productMismatches.push({ month, product, expected: wanted, actual });
    }

    const { count: detailBefore } = await supabaseAdmin.from("orders").select("*", { count: "exact", head: true })
      .eq("shop_key", shop.shop_key).lt("processed_at", windowStart.toISOString());
    const { count: staged } = await supabaseAdmin.from("history_stage_orders").select("*", { count: "exact", head: true });
    const historyCustomers = [...firsts.keys()];
    const { data: customerRows } = await supabaseAdmin.from("customers").select("shopify_id, history_first_order_at")
      .eq("shop_key", shop.shop_key).in("shopify_id", historyCustomers.length ? historyCustomers : [0]);
    const missingHistoryFirst = (customerRows ?? []).filter((c) => !c.history_first_order_at
      || new Date(c.history_first_order_at).getTime() !== new Date(firsts.get(Number(c.shopify_id))!).getTime()).length;

    const report = {
      windowStart: windowStart.toISOString(), exported, included, months: stores.size, productMonths: products.size,
      summaries: { storeMonths: storeRows?.length ?? 0, productMonths: productRows?.length ?? 0 },
      storeMismatches, productMismatches: productMismatches.slice(0, 10), productMismatchCount: productMismatches.length,
      detailOrdersBeforeWindow: detailBefore, stagedRows: staged,
      historyCustomers: historyCustomers.length, historyCustomersWithRow: customerRows?.length ?? 0, missingHistoryFirst,
      totals: { orders: [...stores.values()].reduce((n, s) => n + s.orders, 0), revenue: [...stores.values()].reduce((n, s) => n + s.total, 0) / 10_000 },
    };
    console.log("history", JSON.stringify(report).slice(0, 3000));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(report, null, 1));
    expect(storeMismatches).toEqual([]);
    expect(productMismatches).toEqual([]);
    expect(storeRows?.length).toBe(stores.size);
    expect(productRows?.length).toBe(products.size);
    expect(detailBefore).toBe(0);
    expect(staged).toBe(0);
    expect(missingHistoryFirst).toBe(0);
  }, 900_000);
});
