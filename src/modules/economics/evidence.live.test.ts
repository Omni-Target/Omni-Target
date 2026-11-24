/**
 * Live economics-evidence check (Phase 4, task 3): reads product_economics_evidence for a shop's products on
 * staging and recomputes every figure independently, here, from the raw mirror rows (orders, lines, refunds,
 * refund lines, returns, variants, inventory levels and locations). It also checks the sampled variants'
 * prices and unit costs against Shopify's own answer. Opt-in; staging only; read-only. Writes LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Row = Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const PAID = new Set(["paid", "partially_refunded", "refunded"]);

describe("live economics evidence", () => {
  it("equals a recomputation from the raw mirror rows, and the catalog equals Shopify", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { syncShop } = await import("@/modules/ingestion/sync-repository");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { economicsPolicy, productEconomicsEvidence } = await import("./repository");
    const shop = await syncShop(domain);
    if (!shop) throw new Error("shop not ingestible");
    const key = shop.shopKey;
    const policy = await economicsPolicy();
    const s = policy.settings;
    const asOf = new Date();
    const day = 86_400_000;
    const salesFrom = asOf.getTime() - s.sales_window_days * day;
    const discountFrom = asOf.getTime() - s.discount_window_days * day;
    const maturedBefore = asOf.getTime() - s.return_maturity_days * day;
    const demandFrom = asOf.getTime() - s.established_demand_window_days * day;
    const recentFrom = asOf.getTime() - 30 * day;

    interface Filterable {
      gte(column: string, value: string): Filterable;
      lt(column: string, value: string): Filterable;
      in(column: string, values: unknown[]): Filterable;
      range(from: number, to: number): PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
    }
    async function all(table: string, columns: string, filter: (q: Filterable) => Filterable): Promise<Row[]> {
      const rows: Row[] = [];
      for (let from = 0; ; from += 1000) {
        const query = filter(supabaseAdmin.from(table).select(columns).eq("shop_key", key) as unknown as Filterable);
        const { data, error } = await query.range(from, from + 999);
        if (error) throw new Error(`${table}: ${error.message}`);
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) return rows;
      }
    }
    const inChunks = async (ids: unknown[], fetch: (chunk: unknown[]) => Promise<Row[]>) => {
      const out: Row[] = [];
      for (let i = 0; i < ids.length; i += 300) out.push(...await fetch(ids.slice(i, i + 300)));
      return out;
    };

    // Raw rows: orders in the sales window, their lines, refunds, refund lines and returns.
    const orders = (await all("orders", "shopify_id, processed_at, financial_status, subtotal, total_discounts, total_shipping, total_tax, total_price, total_refunded, is_test",
      (q) => q.gte("processed_at", new Date(salesFrom).toISOString()).lt("processed_at", asOf.toISOString())))
      .filter((o) => !o.is_test);
    const orderById = new Map(orders.map((o) => [Number(o.shopify_id), o]));
    const lines = (await inChunks([...orderById.keys()], (chunk) => all("order_line_items", "shopify_id, order_shopify_id, product_shopify_id, variant_shopify_id, quantity, unit_price, total_discount",
      (q) => q.in("order_shopify_id", chunk)))).filter((l) => n(l.quantity) > 0);
    const refunds = await inChunks([...orderById.keys()], (chunk) => all("refunds", "shopify_id, order_shopify_id, lines_read", (q) => q.in("order_shopify_id", chunk)));
    const refundLines = await inChunks(lines.map((l) => l.shopify_id), (chunk) => all("refund_line_items", "line_item_shopify_id, quantity, restock_type, subtotal", (q) => q.in("line_item_shopify_id", chunk)));
    const returns = await inChunks([...orderById.keys()], (chunk) => all("returns", "shopify_id, order_shopify_id, fields_version", (q) => q.in("order_shopify_id", chunk)));
    const returnLines = await inChunks(lines.map((l) => l.shopify_id), (chunk) => all("return_line_items", "return_shopify_id, line_item_shopify_id, quantity", (q) => q.in("line_item_shopify_id", chunk)));

    // Sample: the 20 products with most paid orders, 5 more sold ones, and 2 never sold.
    const productOrders = new Map<number, Set<number>>();
    for (const l of lines) {
      const o = orderById.get(Number(l.order_shopify_id))!;
      if (!PAID.has(String(o.financial_status)) || l.product_shopify_id === null) continue;
      const set = productOrders.get(Number(l.product_shopify_id)) ?? new Set<number>();
      set.add(Number(l.order_shopify_id));
      productOrders.set(Number(l.product_shopify_id), set);
    }
    const ranked = [...productOrders.entries()].sort((a, b) => b[1].size - a[1].size || a[0] - b[0]).map(([id]) => id);
    const { data: unsold } = await supabaseAdmin.from("products").select("shopify_id").eq("shop_key", key).not("shopify_id", "in", `(${ranked.join(",") || 0})`).limit(2);
    const sample = [...ranked.slice(0, 20), ...ranked.slice(-5), ...(unsold ?? []).map((p) => Number(p.shopify_id))];
    const ids = [...new Set(sample)];

    const evidence = await productEconomicsEvidence(key, ids, asOf, policy);
    expect(evidence.products.map((p) => p.product_id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));

    const productsInOrder = new Map<number, Set<number>>();
    for (const l of lines) {
      const set = productsInOrder.get(Number(l.order_shopify_id)) ?? new Set<number>();
      set.add(Number(l.product_shopify_id));
      productsInOrder.set(Number(l.order_shopify_id), set);
    }
    const mismatches: string[] = [];
    const close = (label: string, a: unknown, b: unknown) => {
      if (a === null || b === null) { if (a !== b) mismatches.push(`${label}: ${a} != ${b}`); return; }
      if (Math.abs(Number(a) - Number(b)) > 1e-6) mismatches.push(`${label}: ${a} != ${b}`);
    };

    for (const p of evidence.products) {
      const mine = lines.filter((l) => Number(l.product_shopify_id) === p.product_id);
      const byOrder = new Map<number, { units: number; gross: number; discount: number; net: number; lineIds: number[] }>();
      for (const l of mine) {
        const e = byOrder.get(Number(l.order_shopify_id)) ?? { units: 0, gross: 0, discount: 0, net: 0, lineIds: [] };
        const gross = n(l.unit_price) * n(l.quantity);
        e.units += n(l.quantity); e.gross += gross; e.discount += n(l.total_discount); e.net += gross - n(l.total_discount); e.lineIds.push(Number(l.shopify_id));
        byOrder.set(Number(l.order_shopify_id), e);
      }
      const exp = { orders_created: 0, orders: 0, orders_unpaid: 0, units: 0, gross: 0, discounts: 0, net: 0, demand_orders: 0, demand_units: 0, recent_units: 0,
        discount_orders: 0, discount_gross: 0, discount_amount: 0, single_orders: 0, single_orders_unrefunded: 0, single_shipping: 0, multi_orders: 0,
        multi_orders_unrefunded: 0, multi_shipping_allocated: 0, orders_with_tax: 0, allocated_tax: 0 };
      const matured = { orders: 0, units: 0, net: 0 };
      const maturedOrders: number[] = [];
      const maturedLines: number[] = [];
      for (const [orderId, e] of byOrder) {
        const o = orderById.get(orderId)!;
        const at = Date.parse(String(o.processed_at));
        const paid = PAID.has(String(o.financial_status));
        exp.orders_created += 1;
        if (!paid) { exp.orders_unpaid += 1; continue; }
        const single = productsInOrder.get(orderId)!.size === 1;
        const refunded = n(o.total_refunded) !== 0;
        exp.orders += 1; exp.units += e.units; exp.gross += e.gross; exp.discounts += e.discount; exp.net += e.net;
        if (at >= demandFrom) { exp.demand_orders += 1; exp.demand_units += e.units; }
        if (at >= recentFrom) exp.recent_units += e.units;
        if (at >= discountFrom) { exp.discount_orders += 1; exp.discount_gross += e.gross; exp.discount_amount += e.discount; }
        if (single) { exp.single_orders += 1; if (!refunded) { exp.single_orders_unrefunded += 1; exp.single_shipping += n(o.total_shipping); } }
        else { exp.multi_orders += 1; if (!refunded) { exp.multi_orders_unrefunded += 1; exp.multi_shipping_allocated += n(o.subtotal) > 0 ? n(o.total_shipping) * e.net / n(o.subtotal) : 0; } }
        if (n(o.total_tax) > 0) exp.orders_with_tax += 1;
        exp.allocated_tax += n(o.subtotal) + n(o.total_shipping) > 0 ? n(o.total_tax) * e.net / (n(o.subtotal) + n(o.total_shipping)) : 0;
        if (at < maturedBefore) { matured.orders += 1; matured.units += e.units; matured.net += e.net; maturedOrders.push(orderId); maturedLines.push(...e.lineIds); }
      }
      for (const [k, v] of Object.entries(exp)) close(`${p.product_id} sales.${k}`, (p.sales as unknown as Row)[k], v);
      const fl = refundLines.filter((r) => maturedLines.includes(Number(r.line_item_shopify_id)) && n(r.quantity) > 0);
      const unread = refunds.filter((r) => maturedOrders.includes(Number(r.order_shopify_id)) && !r.lines_read).length;
      const rl = returnLines.filter((r) => maturedLines.includes(Number(r.line_item_shopify_id)));
      const retUnread = returns.filter((r) => maturedOrders.includes(Number(r.order_shopify_id)) && r.fields_version === null).length;
      const expMatured = {
        ...matured,
        refunded_amount: unread ? null : fl.reduce((t, r) => t + n(r.subtotal), 0),
        refunded_units: unread ? null : fl.reduce((t, r) => t + n(r.quantity), 0),
        returned_restocked_units: unread ? null : fl.filter((r) => r.restock_type === "return" || r.restock_type === "legacy_restock").reduce((t, r) => t + n(r.quantity), 0),
        cancelled_restocked_units: unread ? null : fl.filter((r) => r.restock_type === "cancel").reduce((t, r) => t + n(r.quantity), 0),
        orders_refunded: unread ? null : new Set(fl.map((r) => lines.find((l) => Number(l.shopify_id) === Number(r.line_item_shopify_id))!.order_shopify_id)).size,
        returns: retUnread ? null : new Set(rl.map((r) => r.return_shopify_id)).size,
        returned_units: retUnread ? null : rl.reduce((t, r) => t + n(r.quantity), 0),
        refunds_unread: unread, returns_unread: retUnread,
      };
      for (const [k, v] of Object.entries(expMatured)) close(`${p.product_id} matured.${k}`, (p.matured as unknown as Row)[k], v);
      // Variant mix.
      for (const v of p.variants) {
        const vl = mine.filter((l) => Number(l.variant_shopify_id) === v.id && PAID.has(String(orderById.get(Number(l.order_shopify_id))!.financial_status)));
        close(`${p.product_id} variant ${v.id} units`, v.units, vl.reduce((t, l) => t + n(l.quantity), 0));
      }
    }

    // Inventory: online availability from raw levels and locations.
    const variantIds = evidence.products.flatMap((p) => p.variants.map((v) => v.id));
    const variants = await inChunks(variantIds, (chunk) => all("product_variants", "shopify_id, inventory_item_id, price, unit_cost", (q) => q.in("shopify_id", chunk)));
    const levels = await inChunks(variants.map((v) => v.inventory_item_id).filter(Boolean), (chunk) => all("inventory_levels", "inventory_item_id, location_shopify_id, available, is_active", (q) => q.in("inventory_item_id", chunk)));
    const locations = await all("inventory_locations", "shopify_id, is_active, fulfills_online_orders", (q) => q);
    const online = new Set(locations.filter((l) => l.is_active && l.fulfills_online_orders === true).map((l) => Number(l.shopify_id)));
    for (const p of evidence.products) for (const inv of p.inventory) {
      const item = variants.find((v) => Number(v.shopify_id) === inv.variant_id)?.inventory_item_id;
      const at = levels.filter((l) => Number(l.inventory_item_id) === Number(item) && online.has(Number(l.location_shopify_id)) && l.is_active !== false);
      close(`${p.product_id} inventory ${inv.variant_id}`, inv.online.available ?? (at.length ? 0 : null), at.length ? at.reduce((t, l) => t + n(l.available), 0) : null);
    }

    // Store-wide figures.
    const paidOrders = orders.filter((o) => PAID.has(String(o.financial_status)));
    const maturedPaid = paidOrders.filter((o) => Date.parse(String(o.processed_at)) < maturedBefore);
    const returnedOrders = new Set(returns.filter((r) => returnLines.some((l) => l.return_shopify_id === r.shopify_id)).map((r) => Number(r.order_shopify_id)));
    const expStore = {
      orders: paidOrders.length, orders_unpaid: orders.length - paidOrders.length,
      tax_amount: paidOrders.reduce((t, o) => t + n(o.total_tax), 0),
      tax_base: paidOrders.reduce((t, o) => t + n(o.subtotal) + n(o.total_shipping), 0),
      discount_orders: paidOrders.filter((o) => Date.parse(String(o.processed_at)) >= discountFrom).length,
      discount_amount: paidOrders.filter((o) => Date.parse(String(o.processed_at)) >= discountFrom).reduce((t, o) => t + n(o.total_discounts), 0),
      matured_orders: maturedPaid.length,
      matured_total: maturedPaid.reduce((t, o) => t + n(o.total_price), 0),
      matured_refunded: maturedPaid.reduce((t, o) => t + n(o.total_refunded), 0),
      matured_orders_returned: maturedPaid.filter((o) => returnedOrders.has(Number(o.shopify_id))).length,
    };
    for (const [k, v] of Object.entries(expStore)) close(`store.${k}`, (evidence.store as unknown as Row)[k], v);

    // The catalog the evidence prices with equals Shopify's own answer.
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const sampleVariants = evidence.products.flatMap((p) => p.variants.slice(0, 3));
    let shopifyChecked = 0;
    for (let i = 0; i < sampleVariants.length; i += 50) {
      const slice = sampleVariants.slice(i, i + 50);
      const { nodes } = await shopifyGraphql<{ nodes: Array<{ price: string; inventoryItem: { unitCost: { amount: string } | null } } | null> }>(domain, access.accessToken,
        "query V($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { price inventoryItem { unitCost { amount } } } } }",
        { ids: slice.map((v) => `gid://shopify/ProductVariant/${v.id}`) });
      slice.forEach((v, index) => {
        const raw = nodes[index];
        if (!raw) { mismatches.push(`variant ${v.id} missing in Shopify`); return; }
        close(`variant ${v.id} price vs Shopify`, v.price, Number(raw.price));
        close(`variant ${v.id} unit cost vs Shopify`, v.unit_cost, raw.inventoryItem.unitCost ? Number(raw.inventoryItem.unitCost.amount) : null);
        shopifyChecked += 1;
      });
    }

    const summary = {
      domain, as_of: asOf.toISOString(), policy_version: policy.version, products: evidence.products.length,
      sold: evidence.products.filter((p) => p.sales.orders > 0).length,
      orders_checked: evidence.products.reduce((t, p) => t + p.sales.orders, 0),
      matured_orders_checked: evidence.products.reduce((t, p) => t + p.matured.orders, 0),
      refunded_amount_checked: evidence.products.reduce((t, p) => t + (p.matured.refunded_amount ?? 0), 0),
      variants_checked_against_shopify: shopifyChecked, store: evidence.store, freshness: evidence.freshness, mismatches,
    };
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(summary, null, 2));
    expect(mismatches).toEqual([]);
  }, 600_000);
});
