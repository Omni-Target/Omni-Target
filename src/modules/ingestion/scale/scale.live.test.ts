/**
 * Scale and recovery verification (Phase 2, task 12). The real import workflow
 * against a LOCAL Supabase database (Postgres behind PostgREST, with Supabase's
 * 8 s statement timeout and 1,000-row limit) and a fake Shopify generating the
 * bulk results; R2 staging uses the configured bucket. Opt-in, never in CI.
 *
 *   SCALE_DB_URL=postgresql://...@127.0.0.1:54322/scale_p2   (direct, for setup and checksums)
 *   SCALE_REST_URL=http://127.0.0.1:54331                     (PostgREST on that database)
 *   SCALE_JWT_SECRET=...                                      (that PostgREST's JWT secret)
 *   DATABASE_QUOTA_MB=20000 SCALE_SCENARIOS=large,kill,small SCALE_OUT=report.json
 *   node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.live.config.mjs src/modules/ingestion/scale/scale.live.test.ts
 *
 * Scenarios:
 *  - large: the very large profile (70k products, 210k variants, 420k
 *    inventory levels, 200k customers, 500k orders in the window, 20k before)
 *    end to end; every database call timed against the 8 s timeout; counts
 *    against the profile; peak memory; growth against the capacity projection.
 *  - kill: the same import in its own process, killed with SIGKILL mid-orders,
 *    then resumed by a new run once the dead run's lease has lapsed; every
 *    table must equal the clean run's (counts and checksums).
 *  - small: an expired result URL (re-run through R2 staging, then deleted) and
 *    a denied domain (recorded as partial, the rest imported).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROFILES, startFakeShopify, type ScaleProfile } from "./fake-shopify";
import { database, requireLocal, serviceToken, shopWithImport, startRestProxy, tableChecksums, timeDatabaseCalls, type Database } from "./harness";

const scenarios = new Set((process.env.SCALE_SCENARIOS ?? "large,kill,small").split(","));
const noSleep = async () => {};
const report: Record<string, unknown> = {};

describe.skipIf(!process.env.SCALE_DB_URL)("scale and recovery verification (task 12)", () => {
  let db: Database;
  let proxy: Awaited<ReturnType<typeof startRestProxy>>;
  let windowStart: Date;
  // One clock for every scenario: order dates (and all that derives from them) must be the same in each run.
  const now = new Date();
  let reference: Awaited<ReturnType<typeof tableChecksums>> | null = null;

  beforeAll(async () => {
    db = database(requireLocal(process.env.SCALE_DB_URL, "SCALE_DB_URL"));
    proxy = await startRestProxy(requireLocal(process.env.SCALE_REST_URL, "SCALE_REST_URL"));
    // The app's database client reads these on first use: every write goes to the local database.
    process.env.NEXT_PUBLIC_SUPABASE_URL = proxy.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceToken(process.env.SCALE_JWT_SECRET ?? "");
    const [{ start }] = await db.q<{ start: Date }>("select public.retention_window_start() as start");
    windowStart = new Date(start);
    report.database = (await db.q("select current_setting('server_version') as server"))[0];
    report.statementTimeout = (await db.q("select rolconfig from pg_roles where rolname = 'authenticator'"))[0];
  });
  afterAll(async () => {
    if (process.env.SCALE_OUT) writeFileSync(process.env.SCALE_OUT, JSON.stringify(report, null, 1));
    await proxy?.stop();
    await db?.end();
  });

  const profile = (name: keyof typeof PROFILES): ScaleProfile => ({ ...PROFILES[name], windowStart, now });
  const expected = (p: ScaleProfile) => ({
    products: p.products, product_variants: p.products * p.variantsPerProduct, metafields: p.products * p.metafieldsPerProduct,
    inventory_locations: p.locations, inventory_levels: p.products * p.variantsPerProduct * p.locations, customers: p.customers, orders: p.windowOrders,
    order_line_items: p.windowOrders + Math.ceil(p.windowOrders / 2), refunds: Math.floor(p.windowOrders / p.refundEvery),
    returns: Math.floor(p.windowOrders / p.returnEvery), return_line_items: Math.floor(p.windowOrders / p.returnEvery),
  });
  const counts = (sums: Awaited<ReturnType<typeof tableChecksums>>) => Object.fromEntries(Object.entries(sums).map(([t, s]) => [t, s.rows]));

  it.skipIf(!scenarios.has("large"))("imports the very large profile end to end, every call within the statement timeout", async () => {
    const p = profile("very_large");
    const fake = await startFakeShopify({ profile: p });
    const shop = await shopWithImport(db, "a");
    const { runShopImport } = await import("../workflow");
    const { fakeImportDeps } = await import("./harness");
    const [{ size: before }] = await db.q<{ size: string }>("select pg_database_size(current_database()) as size");
    const timer = timeDatabaseCalls();
    let peakRss = 0;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1_000);
    const started = Date.now();
    const result = await runShopImport(shop.importId, "run_scale_a", noSleep, fakeImportDeps(fake.url));
    const seconds = (Date.now() - started) / 1000;
    clearInterval(sampler);
    timer.stop();
    const [{ size: after }] = await db.q<{ size: string }>("select pg_database_size(current_database()) as size");
    const sums = await tableChecksums(db, shop.shopKey);
    reference = sums;
    const calls = timer.stats();
    const coverage = result.coverage as { rows_written?: number; capacity?: { projectedBytes?: number }; domains?: Record<string, { status: string; records?: number; staged?: boolean }> };
    report.large = {
      outcome: result.outcome, seconds, rowsWritten: coverage.rows_written, rowsPerSecond: Math.round((coverage.rows_written ?? 0) / seconds),
      peakRssMb: Math.round(peakRss / 1048576), growthMb: Math.round((Number(after) - Number(before)) / 1048576),
      projectedMb: coverage.capacity?.projectedBytes ? Math.round(coverage.capacity.projectedBytes / 1048576) : null,
      domains: Object.fromEntries(Object.entries(coverage.domains ?? {}).map(([d, c]) => [d, { status: c.status, records: c.records, staged: c.staged }])),
      counts: counts(sums), expected: expected(p), calls, operations: fake.operations.map((o) => ({ kind: o.kind, objects: o.objectCount })),
    };
    await fake.stop();
    console.log("large", JSON.stringify(report.large).slice(0, 3000));

    expect(result.outcome).toBe("succeeded");
    expect(counts(sums)).toMatchObject(expected(p));
    expect(Object.values(calls).filter((c) => c.over8s > 0 || c.failed > 0)).toEqual([]);
  }, 7_200_000);

  it.skipIf(!scenarios.has("kill"))("resumes an import killed mid-batch, with no duplicates or gaps", async () => {
    if (!reference) throw new Error("the kill scenario compares with the large scenario's clean run");
    const p = profile("very_large");
    const fake = await startFakeShopify({ profile: p });
    const shop = await shopWithImport(db, "b");
    const runner = spawn(process.execPath, ["--env-file=.env.local", "node_modules/vitest/vitest.mjs", "run", "--config", "vitest.live.config.mjs", "src/modules/ingestion/scale/runner.live.test.ts"], {
      env: { ...process.env, SCALE_IMPORT_ID: shop.importId, SCALE_RUN_ID: "run_scale_b_killed", SCALE_FAKE_URL: fake.url },
      detached: true, stdio: "ignore",
    });
    // Killed mid-orders: about a third of the way through the orders result.
    const killAt = Math.floor((p.windowOrders * 2.5) / 3);
    let line = 0;
    for (let i = 0; i < 3_600 && line < killAt; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const rows = await db.q<{ line: string }>("select committed_line as line from public.sync_checkpoints where shop_key = $1 and domain = 'orders'", [shop.shopKey]);
      line = Number(rows[0]?.line ?? 0);
    }
    process.kill(-runner.pid!, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const atKill = await tableChecksums(db, shop.shopKey);
    // The dead run's lease lapses after 15 minutes without a heartbeat; here it is made to lapse at once.
    await db.q("update public.shop_imports set heartbeat_at = now() - interval '1 hour' where id = $1", [shop.importId]);
    const operationsBefore = fake.operations.length;

    const { runShopImport } = await import("../workflow");
    const { fakeImportDeps } = await import("./harness");
    const started = Date.now();
    const result = await runShopImport(shop.importId, "run_scale_b_resumed", noSleep, fakeImportDeps(fake.url));
    const sums = await tableChecksums(db, shop.shopKey);
    const differing = Object.keys(reference).filter((t) => reference![t].rows !== sums[t].rows || reference![t].sum !== sums[t].sum);
    report.kill = {
      killedAtLine: line, rowsAtKill: counts(atKill), resumedOutcome: result.outcome, resumeSeconds: (Date.now() - started) / 1000,
      operationsAfterResume: fake.operations.slice(operationsBefore).map((o) => o.kind), counts: counts(sums), differingFromCleanRun: differing,
    };
    await fake.stop();
    console.log("kill", JSON.stringify(report.kill).slice(0, 3000));

    expect(line).toBeGreaterThanOrEqual(killAt);
    expect(atKill.orders.rows).toBeLessThan(p.windowOrders);
    expect(result.outcome).toBe("succeeded");
    expect(differing).toEqual([]);
    // The resumed run kept the orders result it was reading (from its checkpoint), not a new export.
    expect((report.kill as { operationsAfterResume: string[] }).operationsAfterResume).not.toContain("orders");
  }, 7_200_000);

  it.skipIf(!scenarios.has("small"))("re-runs an expired result through R2 staging and records a denied domain as partial", async () => {
    const p = profile("small");
    const fake = await startFakeShopify({ profile: p, expireOnce: new Set(["catalog"]), deny: new Set(["customers"]) });
    const shop = await shopWithImport(db, "c");
    const { runShopImport } = await import("../workflow");
    const { fakeImportDeps } = await import("./harness");
    const result = await runShopImport(shop.importId, "run_scale_c", noSleep, fakeImportDeps(fake.url));
    const { r2StagingStore, sweepStaged } = await import("../staging");
    const left = await sweepStaged(r2StagingStore(), Date.now(), `bulk/${shop.shopKey}/${shop.importId}/`);
    const sums = await tableChecksums(db, shop.shopKey);
    const domains = (result.coverage as { domains: Record<string, { status: string; reason?: string; staged?: boolean; records?: number }> }).domains;
    report.small = {
      outcome: result.outcome, domains, r2Left: left, counts: counts(sums),
      operations: fake.operations.map((o) => ({ kind: o.kind, resultRequests: o.resultRequests, expired: o.expired })),
    };
    await fake.stop();
    console.log("small", JSON.stringify(report.small).slice(0, 3000));

    expect(result.outcome).toBe("partial");
    expect(domains.customers).toMatchObject({ status: "failed", reason: "access_denied" });
    expect(domains.catalog).toMatchObject({ status: "succeeded", staged: true });
    expect(fake.operations.filter((o) => o.kind === "catalog")).toHaveLength(2);
    expect(left).toEqual({ deleted: 0, remaining: 0 });
    const e = expected(p);
    expect(counts(sums)).toMatchObject({ ...e, customers: 0 });
  }, 1_800_000);
});
