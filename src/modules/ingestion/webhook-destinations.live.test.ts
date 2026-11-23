/**
 * Live webhook destination audit (Phase 3, task 1): lists every webhook
 * subscription this app holds on each staging shop (GraphQL and REST-created
 * alike) and checks that all of them point at the staging deployment, none at
 * production, a retired host or a local address. Also checks that the staging
 * endpoint answers and rejects an unsigned delivery. Read-only on Shopify
 * unless LIVE_ENSURE=1 (below).
 * Opt-in; see vitest.live.config.mjs. Writes the report to LIVE_OUT when set.
 *
 * App-level compliance webhooks (customers/data_request, customers/redact,
 * shop/redact) are configured in shopify.app.toml, not per shop, so they are
 * not listed here.
 *
 * With LIVE_ENSURE=1 it first ensures each shop's sync and lifecycle
 * subscriptions at the expected endpoint (creates or corrects; never removes),
 * which writes to the shops' webhook configuration.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const EXPECTED = process.env.LIVE_EXPECT_ENDPOINT ?? "https://staging.app.omnitarget.co/api/shopify/webhook";
const LIST = `query Subscriptions($after: String) {
  webhookSubscriptions(first: 100, after: $after) {
    nodes { id topic uri createdAt updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

describe("live webhook destinations", () => {
  it("points every staging shop's subscriptions at the staging deployment", async () => {
    const domains = (process.env.LIVE_SHOP_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    if (!domains.length) throw new Error("LIVE_SHOP_DOMAINS is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");

    const shops: Record<string, { status: string; byEndpoint?: Record<string, string[]>; unexpected?: string[] }> = {};
    for (const domain of domains) {
      const access = await getShopifyAccessForShop(domain);
      if (access.status !== "ok") { shops[domain] = { status: access.status }; continue; }
      if (process.env.LIVE_ENSURE === "1") {
        const { ensureSyncSubscriptions } = await import("./subscriptions");
        const ensured = await ensureSyncSubscriptions((query, variables) => shopifyGraphql(domain, access.accessToken, query, variables), EXPECTED);
        if (ensured.failed.length) throw new Error(`${domain}: ${JSON.stringify(ensured.failed)}`);
      }
      const byEndpoint: Record<string, string[]> = {};
      let after: string | null = null;
      for (;;) {
        const page: { webhookSubscriptions: { nodes: Array<{ topic: string; uri: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
          await shopifyGraphql(domain, access.accessToken, LIST, { after });
        for (const n of page.webhookSubscriptions.nodes) (byEndpoint[n.uri] ??= []).push(n.topic);
        if (!page.webhookSubscriptions.pageInfo.hasNextPage) break;
        after = page.webhookSubscriptions.pageInfo.endCursor;
      }
      Object.values(byEndpoint).forEach((topics) => topics.sort());
      shops[domain] = { status: "ok", byEndpoint, unexpected: Object.keys(byEndpoint).filter((uri) => uri !== EXPECTED) };
    }

    // The staging endpoint resolves, and refuses an unsigned delivery.
    const probe = await fetch(EXPECTED, { method: "POST", body: "{}", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
    const report = { expected: EXPECTED, endpointStatus: probe.status, shops };
    const out = JSON.stringify(report, null, 2);
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, out);
    else console.log(out);
    expect(probe.status).toBe(401);
    for (const [domain, shop] of Object.entries(shops)) {
      if (shop.status !== "ok") continue;
      expect(shop.unexpected, domain).toEqual([]);
    }
  }, 120_000);
});
