/**
 * Live export verification (Phase 2): effective installation scopes, and
 * field coverage of a shop's exported orders, with withheld fields told apart
 * from empty ones through the ordinary API. Read-only on Shopify. Opt-in; see
 * vitest.live.config.mjs. Writes its report to LIVE_OUT.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const SAMPLE_QUERY = `{
  orders(first: 100, sortKey: PROCESSED_AT, reverse: true) {
    nodes {
      id customer { id } shippingAddress { city provinceCode countryCodeV2 }
      totalDiscountsSet { shopMoney { amount } } refunds { id }
      lineItems(first: 50) { nodes { product { id } variant { id } totalDiscountSet { shopMoney { amount } } } }
    }
  }
}`;

describe("live export verification", () => {
  it("reports scopes and order field coverage", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");

    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { collectDeniedFields, shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const bulk = await import("./bulk");
    const { parseJsonl, groupUnits } = await import("./jsonl");
    const queries = await import("./queries");
    const { mapReturnsUnit } = await import("./mappers");
    const { classifyField, orderCoverage } = await import("./coverage");
    type Unit = import("./jsonl").JsonlUnit;

    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const gql: import("./bulk").Gql = (query, variables) => shopifyGraphql(domain, access.accessToken, query, variables);

    async function exportUnits(query: string): Promise<Unit[]> {
      const started = await bulk.startBulkQuery(gql, query);
      if (started.outcome !== "started") throw new Error(`not started: ${JSON.stringify(started)}`);
      let operation = await bulk.getBulkOperation(gql, started.id);
      for (let attempt = 0; operation && bulk.bulkPhase(operation).phase === "pending" && attempt < 200; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(bulk.pollDelayMs(attempt), 10_000)));
        operation = await bulk.getBulkOperation(gql, started.id);
      }
      const phase = bulk.bulkPhase(operation!);
      if (phase.phase !== "completed") throw new Error(JSON.stringify(phase));
      const units: Unit[] = [];
      if (phase.url) for await (const unit of groupUnits(parseJsonl(await bulk.openBulkResult(phase.url)))) units.push(unit);
      return units;
    }

    const scopes = (await gql<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>(
      "{ currentAppInstallation { accessScopes { handle } } }")).currentAppInstallation.accessScopes.map((s) => s.handle).sort();

    const catalog = await exportUnits("{ products { edges { node { id variants { edges { node { id } } } } } } }");
    const products = new Set(catalog.map((u) => String(u.root.id)));
    const variants = new Set(catalog.flatMap((u) => u.children.map((c) => String(c.id))));
    const customers = new Set((await exportUnits(queries.customersQuery())).map((u) => String(u.root.id)));
    const orders = await exportUnits(queries.ordersQuery());
    const returnsUnits = await exportUnits(queries.returnsQuery());
    const coverage = orderCoverage(orders, { customers, products, variants });
    const returns = returnsUnits.reduce((acc, u) => {
      const m = mapReturnsUnit(u);
      return { returns: acc.returns + m.returns.length, lines: acc.lines + m.lineItems.length, withReason: acc.withReason + m.lineItems.filter((l) => l.return_reason).length };
    }, { returns: 0, lines: 0, withReason: 0 });

    const sample = await collectDeniedFields(() => gql<{ orders: { nodes: unknown[] } }>(SAMPLE_QUERY));
    const denied = (prefix: string) => sample.deniedFields.some((path) => path.startsWith(prefix));
    const field = (present: number, path: string, records = coverage.orders) => classifyField({ records, present, denied: denied(path) });
    const availability = {
      "Order.customer": field(coverage.withCustomer, "orders.nodes.customer"),
      "Order.shippingAddress.city": field(coverage.withCity, "orders.nodes.shippingAddress"),
      "Order.shippingAddress.provinceCode": field(coverage.withProvince, "orders.nodes.shippingAddress"),
      "Order.shippingAddress.countryCodeV2": field(coverage.withCountry, "orders.nodes.shippingAddress"),
      "Order.totalDiscounts": field(coverage.withOrderDiscount, "orders.nodes.totalDiscountsSet"),
      "Order.refunds": field(coverage.withRefunds, "orders.nodes.refunds"),
      "LineItem.product": field(coverage.lineItemsWithProduct, "orders.nodes.lineItems", coverage.lineItems),
      "LineItem.variant": field(coverage.lineItemsWithVariant, "orders.nodes.lineItems", coverage.lineItems),
      "LineItem.totalDiscount": field(coverage.lineItemsDiscounted, "orders.nodes.lineItems", coverage.lineItems),
      "Return": classifyField({ records: coverage.orders, present: returns.returns, denied: false }),
    };
    const report = {
      scopes, scopeCount: scopes.length,
      catalog: { products: products.size, variants: variants.size }, customers: customers.size,
      coverage, returns, availability, deniedInSample: sample.deniedFields,
    };
    console.log("coverage", JSON.stringify(report));
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify(report, null, 1));
    expect(scopes).toEqual(expect.arrayContaining(["read_orders", "read_all_orders"]));
  });
});
