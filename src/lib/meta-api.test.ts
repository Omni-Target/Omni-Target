import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { META_API_VERSION, META_GRAPH_BASE, META_OAUTH_DIALOG } from "./meta-api";

/** Phase 5, task 2: one Meta API version, current, in one place. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("the Meta API version", () => {
  it("is v25.0: the only Marketing API version Meta has not expired (changelog, 2026-11-28)", () => {
    expect(META_API_VERSION).toBe("v25.0");
    expect(META_GRAPH_BASE).toBe("https://graph.facebook.com/v25.0");
    expect(META_OAUTH_DIALOG).toBe("https://www.facebook.com/v25.0/dialog/oauth");
  });

  it("is written nowhere else in the source", () => {
    const offenders = sourceFiles(join(process.cwd(), "src"))
      .filter((f) => !f.endsWith("meta-api.ts") && !f.endsWith("meta-api.test.ts"))
      .filter((f) => /facebook\.com\/v\d+\.\d+/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
