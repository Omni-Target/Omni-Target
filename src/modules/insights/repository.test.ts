import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/supabase", () => ({ supabaseAdmin: {} }));

import { importsComplete } from "./repository";

describe("whether the snapshot's inputs are complete (task 11)", () => {
  const coverage = (domains: Record<string, string>) => ({ domains: Object.fromEntries(Object.entries(domains).map(([d, status]) => [d, { status }])) });

  it("takes each domain from the newest import that covered it, so a scoped import keeps the others", () => {
    // Newest first: a scoped orders import after a full one.
    expect(importsComplete([coverage({ orders: "succeeded", customers: "succeeded" }), coverage({ orders: "succeeded", catalog: "succeeded" })], ["orders", "catalog"])).toBe(true);
    // As a scoped import records it: the domains it did not import are skipped.
    expect(importsComplete([coverage({ orders: "succeeded", catalog: "skipped" }), coverage({ orders: "succeeded", catalog: "succeeded" })], ["orders", "catalog"])).toBe(true);
    expect(importsComplete([coverage({ catalog: "partial" }), coverage({ orders: "succeeded", catalog: "succeeded" })], ["orders", "catalog"])).toBe(false);
    expect(importsComplete([coverage({ orders: "succeeded" })], ["orders", "catalog"])).toBe(false);
    expect(importsComplete([], ["orders"])).toBe(false);
  });
});
