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

  it("never imports database access from a client component", () => {
    const offenders = files.filter((file) => isClientModule(file.text) && importsDatabase(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
