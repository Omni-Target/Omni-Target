import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireUser: vi.fn(),
  enforceRateLimit: vi.fn(),
  getCampaignById: vi.fn(),
  getBriefVersions: vi.fn(),
  queryUserIntegrationSelect: vi.fn(),
  saveRecoveredCreativeHooks: vi.fn(),
  getUserIntegration: vi.fn(),
  generateCreativeHooksOnly: vi.fn(),
  generateRecommendations: vi.fn(),
}));

vi.mock("@/lib/api/require-user", () => ({ requireUser: m.requireUser }));
vi.mock("@/lib/api/rate-limit", () => ({ enforceRateLimit: m.enforceRateLimit }));
vi.mock("@/lib/db", () => ({
  getCampaignById: m.getCampaignById,
  getBriefVersions: m.getBriefVersions,
  queryUserIntegrationSelect: m.queryUserIntegrationSelect,
  saveRecoveredCreativeHooks: m.saveRecoveredCreativeHooks,
  getUserIntegration: m.getUserIntegration,
}));
vi.mock("@/lib/insights-engine", () => ({
  generateCreativeHooksOnly: m.generateCreativeHooksOnly,
  generateRecommendations: m.generateRecommendations,
}));

import { legacyAiEndpointsEnabled, retiredEndpointResponse } from "./retired-endpoint";
import { GET as storeInsights } from "@/app/api/store/insights/route";
import { POST as targeting } from "@/app/api/campaigns/generate/targeting/route";

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.requireUser.mockResolvedValue({ ok: true, userId: "user-1" });
  m.enforceRateLimit.mockResolvedValue({ ok: true });
  delete process.env.LEGACY_AI_ENDPOINTS_ENABLED;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retired legacy AI endpoints (SEC-08)", () => {
  it("is retired by default and can be re-enabled by flag", () => {
    expect(legacyAiEndpointsEnabled({})).toBe(false);
    expect(legacyAiEndpointsEnabled({ LEGACY_AI_ENDPOINTS_ENABLED: "true" })).toBe(true);
  });

  it("answers 410 and logs the hit when retired", async () => {
    const res = retiredEndpointResponse("/api/generate-brief", new Request("https://app.test/x"), "user-1");
    expect(res?.status).toBe(410);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("retired_endpoint_hit"));
  });

  it("returns null (route proceeds) when re-enabled", () => {
    process.env.LEGACY_AI_ENDPOINTS_ENABLED = "true";
    expect(retiredEndpointResponse("/api/generate-brief", null, "user-1")).toBeNull();
  });

  it("/api/store/insights makes no LLM call while retired", async () => {
    const res = await storeInsights(new Request("https://app.test/api/store/insights"));
    expect(res.status).toBe(410);
    expect(m.generateRecommendations).not.toHaveBeenCalled();
    expect(m.getUserIntegration).not.toHaveBeenCalled();
  });
});

describe("hook recovery requires an owned brief (SEC-08)", () => {
  it("refuses targeting/hooks generation without a campaign and version, before any DB or LLM work", async () => {
    const res = await targeting(
      new Request("https://app.test/api/campaigns/generate/targeting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productName: "Tee", productDescription: "d", productPrice: "10" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(m.generateCreativeHooksOnly).not.toHaveBeenCalled();
    expect(m.getCampaignById).not.toHaveBeenCalled();
  });
});
