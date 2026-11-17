import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capacityLevel, importPreflight, projectedImportBytes, quotaBytes } from "./policy";

const MIB = 1024 * 1024;
const FREE = 500 * MIB;
const STAGING_TODAY = 16 * MIB;

describe("capacity policy (task 10)", () => {
  it("uses the Free plan's 500 MB unless DATABASE_QUOTA_MB says otherwise, and rejects nonsense", () => {
    expect(quotaBytes(undefined)).toBe(FREE);
    expect(quotaBytes("")).toBe(FREE);
    expect(quotaBytes("8192")).toBe(8192 * MIB);
    for (const bad of ["0", "-5", "1.5", "lots"]) expect(() => quotaBytes(bad)).toThrow("DATABASE_QUOTA_MB");
  });

  it("warns at 60% and is critical at 75% of the quota", () => {
    expect(capacityLevel(0.599 * FREE, FREE)).toBe("ok");
    expect(capacityLevel(0.6 * FREE, FREE)).toBe("warning");
    expect(capacityLevel(0.749 * FREE, FREE)).toBe("warning");
    expect(capacityLevel(0.75 * FREE, FREE)).toBe("critical");
  });

  it("projects every measured profile at or above its measured size, without being wildly conservative", () => {
    const report = JSON.parse(readFileSync(join(process.cwd(), "architecture/capacity/fixtures-2026-11-17.json"), "utf8"));
    for (const [name, profile] of Object.entries<{ products: number; orders: number; mirror: number }>(report.profiles)) {
      const projected = projectedImportBytes(profile);
      expect(projected, name).toBeGreaterThanOrEqual(profile.mirror);
      expect(projected, name).toBeLessThanOrEqual(profile.mirror * 1.5);
    }
  });

  it("refuses the incident-scale import on the Free plan and lets it through on Pro", () => {
    const incident = { products: 70_000, orders: 500_000 };
    expect(importPreflight({ currentBytes: STAGING_TODAY, quota: FREE, ...incident })).toMatchObject({ decision: "refuse", reason: "capacity_exceeded", level_after: "critical" });
    expect(importPreflight({ currentBytes: STAGING_TODAY, quota: 8192 * MIB, ...incident })).toMatchObject({ decision: "proceed", level_after: "ok" });
  });

  it("lets a large shop in on Free with a warning, and a medium one without", () => {
    expect(importPreflight({ currentBytes: STAGING_TODAY, quota: FREE, products: 20_000, orders: 200_000 })).toMatchObject({ decision: "proceed", level_after: "warning" });
    expect(importPreflight({ currentBytes: STAGING_TODAY, quota: FREE, products: 5_000, orders: 50_000 })).toMatchObject({ decision: "proceed", level_after: "ok" });
    expect(() => projectedImportBytes({ products: -1, orders: 0 })).toThrow();
  });
});
