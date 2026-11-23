import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 1 task 1: the service-role client must stay on the server. These checks
 * read the source, so they fail in CI before a bad import reaches a build.
 */
const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
const isClientModule = (text: string) => /^\s*["']use client["']/.test(text);
const importsDatabase = (text: string) =>
  /from\s+["'](@\/lib\/db|@\/platform\/supabase|@\/platform\/env|\.\.?\/(?:lib\/)?db|\.\/supabase)["']/.test(text);

describe("server-only boundaries", () => {
  it("marks the database client and environment modules as server-only", () => {
    for (const path of ["platform/supabase.ts", "platform/env.ts", "lib/db.ts"]) {
      const text = files.find((file) => file.path === path)?.text ?? "";
      expect(text, path).toMatch(/^import ["']server-only["'];/m);
    }
  });

  it("creates a Supabase client only in the platform module", () => {
    const creators = files.filter((file) => /createClient\(/.test(file.text) && /@supabase\/supabase-js/.test(file.text));
    expect(creators.map((file) => file.path)).toEqual(["platform/supabase.ts"]);
  });

  it("uses the service-role client only in repositories (Phase 1 task 7)", () => {
    const isRepository = (path: string) => path === "lib/db.ts" || /^(modules|platform)\//.test(path);
    const offenders = files
      .filter((file) => /from\s+["']@\/platform\/supabase["']/.test(file.text) || /\bsupabaseAdmin\b/.test(file.text))
      .filter((file) => !isRepository(file.path))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("never imports database access from a client component", () => {
    const offenders = files.filter((file) => isClientModule(file.text) && importsDatabase(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});

describe("no full sync inside a request (Phase 2, task 11)", () => {
  // The store snapshot is built by the shop-insights worker from the canonical mirror; routes and pages only read it.
  it("never calls the REST snapshot sync from a route or a page", () => {
    const offenders = files.filter((file) => file.path.startsWith("app/") && /\b(fetchShopifyStoreData|executeShopifyStoreSync)\b/.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("builds the snapshot only in the worker module", () => {
    const callers = files.filter((file) => /\bbuildCanonicalStoreData\(/.test(file.text) && !file.path.startsWith("modules/insights/")).map((file) => file.path);
    expect(callers).toEqual([]);
  });

  // Phase 3, task 5: Shopify is read only by background syncs. The snapshot is built, and pages render, from the database.
  const SHOPIFY_READS = /\b(shopifyGraphql|fetchShopifyPrespendIntelligence|fetchShopifyReturnEvidence|fetchShopifyStoreData|fetchShopifyStoreLogo|getShopifyAccessForShop|shopifyAdminRestUrl)\b/;
  it("builds and reads the store snapshot without any Shopify request", () => {
    const worker = ["modules/insights/live.ts", "modules/insights/canonical.ts", "modules/insights/read.ts", "modules/insights/context.ts", "modules/insights/repository.ts"];
    expect(files.filter((file) => worker.includes(file.path)).map((file) => file.path).sort()).toEqual([...worker].sort());
    expect(files.filter((file) => worker.includes(file.path) && SHOPIFY_READS.test(file.text)).map((file) => file.path)).toEqual([]);
  });

  it("renders no page or layout from a Shopify request", () => {
    const offenders = files.filter((file) => file.path.startsWith("app/") && /\/(page|layout)\.tsx?$/.test(file.path) && SHOPIFY_READS.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
