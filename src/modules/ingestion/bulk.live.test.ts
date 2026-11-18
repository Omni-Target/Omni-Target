/**
 * Live bulk operation check (Phase 2, task 4): a real bulk query on a shop,
 * streamed and grouped, then staged in the private JSONL bucket, read back,
 * deleted and verified gone. Read-only on Shopify. Opt-in; see
 * vitest.live.config.mjs. Refuses any database but the staging project.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
const QUERY = `{
  products {
    edges { node { id title updatedAt variants { edges { node { id sku } } } } }
  }
}`;

describe("live bulk operation", () => {
  it("runs, streams grouped units, stages in R2 and cleans up", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");

    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const bulk = await import("./bulk");
    const { parseJsonl, groupUnits } = await import("./jsonl");
    const staging = await import("./staging");

    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const gql: import("./bulk").Gql = (query, variables) => shopifyGraphql(domain, access.accessToken, query, variables);

    const started = await bulk.startBulkQuery(gql, QUERY);
    if (started.outcome !== "started") throw new Error(`not started: ${JSON.stringify(started)}`);
    let operation = await bulk.getBulkOperation(gql, started.id);
    for (let attempt = 0; operation && bulk.bulkPhase(operation).phase === "pending" && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(bulk.pollDelayMs(attempt), 10_000)));
      operation = await bulk.getBulkOperation(gql, started.id);
    }
    const phase = bulk.bulkPhase(operation!);
    console.log("operation", { status: operation?.status, objects: operation?.objectCount, roots: operation?.rootObjectCount, bytes: operation?.fileSize });
    expect(phase.phase).toBe("completed");
    if (phase.phase !== "completed" || !phase.url) return;

    // Streamed straight from Shopify, grouped.
    let units = 0;
    let children = 0;
    for await (const unit of groupUnits(parseJsonl(await bulk.openBulkResult(phase.url)))) {
      units += 1;
      children += unit.children.length;
      expect(String(unit.root.id)).toMatch(/^gid:\/\/shopify\/Product\//);
      for (const child of unit.children) expect(child.__parentId).toBe(unit.root.id);
    }
    console.log("streamed", { units, children });
    expect(units).toBe(operation!.rootObjectCount);
    expect(units + children).toBe(operation!.objectCount);

    // Staged in R2, read back identically, then deleted and verified gone.
    const store = staging.r2StagingStore();
    const key = staging.stagingKey({ shopKey: 0, syncRunId: randomUUID(), domain: "catalog", bulkOperationId: started.numericId });
    const staged = await staging.stageStream(store, key, await bulk.openBulkResult(phase.url));
    let restaged = 0;
    for await (const unit of groupUnits(parseJsonl(await staging.openStaged(store, key)))) restaged += 1 + unit.children.length;
    console.log("staged", { bytes: staged.bytes, parts: staged.parts, rows: restaged });
    expect(staged.bytes).toBe(operation!.fileSize);
    expect(restaged).toBe(units + children);
    expect(await staging.deleteStaged(store, key)).toBe(true);
  });
});
