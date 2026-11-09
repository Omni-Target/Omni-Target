import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger";

let lines: { level: string; record: Record<string, unknown> }[] = [];

beforeEach(() => {
  lines = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: string) => lines.push({ level, record: JSON.parse(line) }));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("structured logger (Phase 1 task 1)", () => {
  it("writes one JSON line with its context", () => {
    createLogger({ requestId: "req-1" }).info("sync started", { workspaceId: "ws-1", shopId: "shop-1" });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("log");
    expect(lines[0].record).toMatchObject({ level: "info", msg: "sync started", requestId: "req-1", workspaceId: "ws-1", shopId: "shop-1" });
    expect(typeof lines[0].record.ts).toBe("string");
  });

  it("carries context through child loggers", () => {
    createLogger({ requestId: "req-1" }).child({ job: "reconcile" }).warn("slow", { attempt: 2 });
    expect(lines[0].level).toBe("warn");
    expect(lines[0].record).toMatchObject({ requestId: "req-1", job: "reconcile", attempt: 2 });
  });

  it("removes tokens, emails and secrets from messages, context and errors", () => {
    createLogger().error(
      "refresh failed for owner@example.com with shpat_abc123",
      { accessToken: "plain-token-value", note: "Bearer abc.def.ghi" },
      new Error("upstream said shpat_def456 for someone@example.com"),
    );
    const text = JSON.stringify(lines[0].record);
    for (const secret of ["owner@example.com", "shpat_abc123", "plain-token-value", "abc.def.ghi", "shpat_def456", "someone@example.com"]) {
      expect(text).not.toContain(secret);
    }
    expect(lines[0].level).toBe("error");
    expect(lines[0].record).toMatchObject({ error: { name: "Error" } });
  });

  it("drops debug lines unless LOG_LEVEL is debug", () => {
    createLogger().debug("noisy");
    expect(lines).toHaveLength(0);
    vi.stubEnv("LOG_LEVEL", "debug");
    createLogger().debug("noisy");
    expect(lines).toHaveLength(1);
  });
});
