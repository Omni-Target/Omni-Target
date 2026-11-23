/**
 * Live returns check (Phase 3, task 4), against Shopify's raw answer:
 *  - refunds' line items (quantity, restock type, order line) and the return
 *    each refund settles;
 *  - orders' Collective flag, return status and line restrictions;
 *  - return evidence: the mirror's (product_return_evidence) against the
 *    shared pure computation (calculateReturnEvidence) over Shopify's own
 *    orders, on the same window (processed date, a year less 60 days).
 * Options, each writing to staging first: LIVE_REFRESH_REFUND_LINES=1 runs the
 * daily refund-lines read; LIVE_RESYNC_ORDERS=N re-reads N orders by ID.
 * Opt-in; staging only. Writes LIVE_OUT.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Raw = Record<string, unknown>;
const idOf = (gid: unknown) => Number(String(gid).split("/").pop());
const RAW_REFUNDS = `query R($ids: [ID!]!) { nodes(ids: $ids) { ... on Refund { id return { id }
  refundLineItems(first: 100) { nodes { id quantity restockType lineItem { id } } } } } }`;
const RAW_ORDERS = `query O($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id productNetwork returnStatus
  lineItems(first: 50) { nodes { id restockable nonFulfillableQuantity requiresShipping isGiftCard } } } } }`;
const EVIDENCE_ORDERS = `query E($after: String, $filter: String!) {
  orders(first: 25, after: $after, query: $filter, sortKey: PROCESSED_AT) {
    nodes { id test cancelledAt displayFinancialStatus
      lineItems(first: 50) { nodes { quantity product { legacyResourceId } } pageInfo { hasNextPage } }
      returns(first: 10) { nodes { returnLineItems(first: 20) { nodes { __typename ... on ReturnLineItem { processedQuantity
        returnReasonDefinition { name } fulfillmentLineItem { lineItem { quantity product { legacyResourceId } } } } } pageInfo { hasNextPage } } }
        pageInfo { hasNextPage } }
      refunds { refundLineItems(first: 50) { nodes { quantity lineItem { quantity product { legacyResourceId } } } pageInfo { hasNextPage } } } }
    pageInfo { hasNextPage endCursor } } }`;

describe("live returns", () => {
  it("stores refunds' lines and links, order restrictions, and return evidence as Shopify gives them", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { calculateReturnEvidence } = await import("@/lib/connectors/shopify-returns");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).single();
    if (!shop) throw new Error("shop not modelled");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const gql = <T,>(query: string, variables?: Raw) => shopifyGraphql<T>(domain, access.accessToken, query, variables);
    const report: Record<string, unknown> = {};
    const mismatches: string[] = [];
    const differ = (where: string, want: unknown, got: unknown) => {
      if (JSON.stringify(want ?? null) !== JSON.stringify(got ?? null)) mismatches.push(`${where}: shopify ${JSON.stringify(want)} stored ${JSON.stringify(got)}`);
    };

    if (process.env.LIVE_REFRESH_REFUND_LINES === "1") {
      const { refreshRefundLines } = await import("./sync-live");
      report.refundLinesRefresh = await refreshRefundLines(domain);
    }
    const resync = Number(process.env.LIVE_RESYNC_ORDERS ?? 0);
    if (resync > 0) {
      const { recordSyncEvents } = await import("./sync-repository");
      const { processShopEvents } = await import("./sync");
      const { liveSyncDeps } = await import("./sync-live");
      // Orders with refunds first, so refunds' links and lines are exercised through the webhook path too.
      const { data: picked } = await supabaseAdmin.from("refunds").select("order_shopify_id").eq("shop_key", shop.shop_key).order("order_shopify_id").limit(resync);
      const tag = `p3-orders-${Date.now().toString(36)}`;
      await recordSyncEvents(domain, [...new Set((picked ?? []).map((r) => Number(r.order_shopify_id)))].map((id) => ({
        webhook_id: `reconcile:${tag}:orders/updated:${id}`, topic: "orders/updated", triggered_at: new Date().toISOString(),
        payload: { id, updated_at: new Date().toISOString() },
      })));
      report.resynced = await processShopEvents(domain, randomUUID(), liveSyncDeps(), { budgetMs: 600_000 });
    }

    // Refunds and their lines.
    const { data: refunds } = await supabaseAdmin.from("refunds").select("shopify_id, return_shopify_id, lines_read").eq("shop_key", shop.shop_key).eq("lines_read", true).limit(500);
    const refundIds = (refunds ?? []).map((r) => Number(r.shopify_id));
    let refundLines = 0;
    for (let i = 0; i < refundIds.length; i += 25) {
      const slice = refundIds.slice(i, i + 25);
      const { nodes } = await gql<{ nodes: Array<Raw | null> }>(RAW_REFUNDS, { ids: slice.map((id) => `gid://shopify/Refund/${id}`) });
      const { data: stored } = await supabaseAdmin.from("refund_line_items").select("shopify_id, refund_shopify_id, line_item_shopify_id, quantity, restock_type")
        .eq("shop_key", shop.shop_key).in("refund_shopify_id", slice);
      slice.forEach((id, index) => {
        const raw = nodes[index];
        const s = (refunds ?? []).find((r) => Number(r.shopify_id) === id);
        if (!raw) { mismatches.push(`refund ${id}: Shopify no longer has it`); return; }
        differ(`refund ${id} return`, (raw.return as Raw | null)?.id ? idOf((raw.return as Raw).id) : null, s?.return_shopify_id ? Number(s.return_shopify_id) : null);
        const want = ((raw.refundLineItems as { nodes: Raw[] }).nodes ?? []).map((l) => [idOf(l.id), (l.lineItem as Raw | null)?.id ? idOf((l.lineItem as Raw).id) : null, l.quantity, String(l.restockType).toLowerCase()]).sort();
        const got = (stored ?? []).filter((l) => Number(l.refund_shopify_id) === id).map((l) => [Number(l.shopify_id), l.line_item_shopify_id ? Number(l.line_item_shopify_id) : null, l.quantity, l.restock_type]).sort();
        refundLines += got.length;
        differ(`refund ${id} lines`, want, got);
      });
    }

    // Orders read with Phase 3's fields.
    const { data: readOrders } = await supabaseAdmin.from("orders").select("shopify_id, product_network, return_status").eq("shop_key", shop.shop_key).not("product_network", "is", null).limit(200);
    let lineRestrictions = 0;
    for (let i = 0; i < (readOrders ?? []).length; i += 25) {
      const slice = (readOrders ?? []).slice(i, i + 25);
      const ids = slice.map((o) => Number(o.shopify_id));
      const { nodes } = await gql<{ nodes: Array<Raw | null> }>(RAW_ORDERS, { ids: ids.map((id) => `gid://shopify/Order/${id}`) });
      const { data: lines } = await supabaseAdmin.from("order_line_items").select("shopify_id, restockable, non_fulfillable_quantity, requires_shipping, is_gift_card")
        .eq("shop_key", shop.shop_key).in("order_shopify_id", ids);
      slice.forEach((o, index) => {
        const raw = nodes[index];
        if (!raw) return;
        differ(`order ${o.shopify_id}`, [raw.productNetwork, raw.returnStatus ? String(raw.returnStatus).toLowerCase() : null], [o.product_network, o.return_status]);
        for (const l of (raw.lineItems as { nodes: Raw[] }).nodes ?? []) {
          const s = (lines ?? []).find((x) => Number(x.shopify_id) === idOf(l.id));
          if (!s) { mismatches.push(`line ${idOf(l.id)}: not stored`); continue; }
          lineRestrictions += 1;
          differ(`line ${idOf(l.id)}`, [l.restockable, l.nonFulfillableQuantity, l.requiresShipping, l.isGiftCard], [s.restockable, s.non_fulfillable_quantity, s.requires_shipping, s.is_gift_card]);
        }
      });
    }

    // Return evidence: the same window and rules, computed from Shopify's orders.
    const asOf = new Date();
    const from = new Date(asOf.getTime() - 365 * 86_400_000).toISOString();
    const until = new Date(asOf.getTime() - 60 * 86_400_000).toISOString();
    const rawOrders: Raw[] = [];
    for (let after: string | null = null, page = 0; page < 200; page++) {
      const data: { orders: { nodes: Raw[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
        await gql(EVIDENCE_ORDERS, { after, filter: `processed_at:>='${from}' processed_at:<'${until}'` });
      rawOrders.push(...data.orders.nodes.filter((o) => !o.test));
      if (!data.orders.pageInfo.hasNextPage) break;
      after = data.orders.pageInfo.endCursor;
    }
    const expected = calculateReturnEvidence(rawOrders as never);
    const productIds = Object.keys(expected).map(Number);
    const mirror: Raw[] = [];
    for (let i = 0; i < productIds.length; i += 500) {
      const { data, error } = await supabaseAdmin.rpc("product_return_evidence", { p_shop_key: shop.shop_key, p_product_ids: productIds.slice(i, i + 500), p_as_of: asOf.toISOString() });
      if (error) throw new Error(error.message);
      mirror.push(...((data as Raw[]) ?? []));
    }
    for (const [id, want] of Object.entries(expected)) {
      const got = mirror.find((m) => Number(m.product_id) === Number(id));
      if (!got) { mismatches.push(`evidence ${id}: not computed`); continue; }
      differ(`evidence ${id}`, [want.eligible_units, want.processed_return_units, want.refunded_units, want.processed_return_rate === null ? null : Math.round(want.processed_return_rate * 10_000) / 10_000, want.primary_reason ?? null, want.risk],
        [got.eligible_units, got.processed_return_units, got.refunded_units, got.processed_return_rate === null ? null : Number(got.processed_return_rate), got.primary_reason ?? null, got.risk]);
    }

    Object.assign(report, { refunds: refundIds.length, refundLines, orders: (readOrders ?? []).length, lineRestrictions,
      evidence: { orders: rawOrders.length, products: productIds.length, withRefunds: Object.values(expected).filter((e) => (e.refunded_units ?? 0) > 0).length },
      mismatches: mismatches.slice(0, 50), mismatchCount: mismatches.length });
    const out = JSON.stringify(report, null, 2);
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, out);
    else console.log(out);
    expect(mismatches).toEqual([]);
  }, 900_000);
});
