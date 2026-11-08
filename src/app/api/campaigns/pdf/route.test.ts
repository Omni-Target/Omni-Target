import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireUser: vi.fn(),
  enforceRateLimit: vi.fn(),
  buildBriefHTML: vi.fn(),
}));

vi.mock("@/lib/api/require-user", () => ({ requireUser: m.requireUser }));
vi.mock("@/lib/api/rate-limit", () => ({ enforceRateLimit: m.enforceRateLimit }));
vi.mock("@/lib/brief-html-template", () => ({ buildBriefHTML: m.buildBriefHTML }));

import { POST } from "./route";

const valid = {
  brandName: "Acme",
  productName: "Tee",
  campaignGoal: "Drive Website Sales",
  copy: { headline: "h", primaryText: "p", description: "d", cta: "Shop Now", copywriterNote: "n" },
  budget: { currency: "USD", recommended_daily: 20 },
  timing: { peak_days: ["Friday"] },
  warnings: [],
  generatedAt: "2026-11-08T01:00:00.000Z",
};

const post = (body: string, contentType = "application/json", query = "?embed=1") =>
  POST(
    new Request(`https://app.test/api/campaigns/pdf${query}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }),
  );

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.requireUser.mockResolvedValue({ ok: true, userId: "user-1" });
  m.enforceRateLimit.mockResolvedValue({ ok: true });
  m.buildBriefHTML.mockResolvedValue("<!DOCTYPE html><html></html>");
});

describe("POST /api/campaigns/pdf (SEC-06)", () => {
  it("refuses non-JSON bodies (cross-site form posts) before rendering", async () => {
    const res = await post(JSON.stringify(valid), "text/plain");
    expect(res.status).toBe(415);
    expect(m.buildBriefHTML).not.toHaveBeenCalled();
  });

  it("refuses oversized bodies", async () => {
    const res = await post(JSON.stringify({ ...valid, filler: "x".repeat(600 * 1024) }));
    expect(res.status).toBe(413);
    expect(m.buildBriefHTML).not.toHaveBeenCalled();
  });

  it("refuses payloads that fail validation and never renders them", async () => {
    const res = await post(JSON.stringify({ ...valid, budget: { currency_symbol: "<script>" } }));
    expect(res.status).toBe(400);
    expect(m.buildBriefHTML).not.toHaveBeenCalled();
  });

  it("renders valid payloads as no-store UTF-8 HTML", async () => {
    const res = await post(JSON.stringify(valid));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(m.buildBriefHTML).toHaveBeenCalledWith(expect.objectContaining({ brandName: "Acme" }), { embed: true });
  });

  it("does not leak internal error details", async () => {
    m.buildBriefHTML.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    const res = await post(JSON.stringify(valid));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("10.0.0.5");
  });

  it("requires authentication", async () => {
    m.requireUser.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await post(JSON.stringify(valid));
    expect(res.status).toBe(401);
    expect(m.buildBriefHTML).not.toHaveBeenCalled();
  });
});
