import { describe, expect, it } from "vitest";
import { CreativeHookGenerationError, TargetingGenerationError, assertUsableRecommendations } from "./generation-guard";
import { isDefinitiveGenerationResponse } from "./pending-generation";

const hooks = [{}, {}, {}];

describe("assertUsableRecommendations (AI-03: never charge for degraded output)", () => {
  it("passes a fully generated brief", () => {
    expect(() =>
      assertUsableRecommendations({ generation_status: "generated", creative_hooks_status: "generated", creative_hooks: hooks }),
    ).not.toThrow();
  });

  it("rejects default (fallback) audience targeting", () => {
    expect(() =>
      assertUsableRecommendations({ generation_status: "fallback", creative_hooks_status: "generated", creative_hooks: hooks }),
    ).toThrow(TargetingGenerationError);
  });

  it("rejects fallback creative hooks", () => {
    expect(() =>
      assertUsableRecommendations({ generation_status: "generated", creative_hooks_status: "fallback", creative_hooks: hooks }),
    ).toThrow(CreativeHookGenerationError);
  });

  it("rejects fewer than three hooks even if the status claims success", () => {
    expect(() =>
      assertUsableRecommendations({ generation_status: "generated", creative_hooks_status: "generated", creative_hooks: [{}] }),
    ).toThrow(CreativeHookGenerationError);
  });
});

describe("isDefinitiveGenerationResponse", () => {
  it("treats 4xx as final", () => {
    expect(isDefinitiveGenerationResponse(422, { error: "x" })).toBe(true);
    expect(isDefinitiveGenerationResponse(402, null)).toBe(true);
  });

  it("treats a 5xx stating nothing was charged as final (no receipt polling)", () => {
    expect(isDefinitiveGenerationResponse(502, { error: "x", charged: false })).toBe(true);
  });

  it("keeps ambiguous 5xx responses in receipt-recovery mode", () => {
    expect(isDefinitiveGenerationResponse(500, { error: "x" })).toBe(false);
    expect(isDefinitiveGenerationResponse(503, null)).toBe(false);
    expect(isDefinitiveGenerationResponse(502, { charged: "false" })).toBe(false);
  });
});
