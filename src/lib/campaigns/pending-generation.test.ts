import { describe, expect, it } from "vitest";
import { PENDING_GENERATION_KEY, clearPendingGeneration, parsePendingGeneration, savePendingGeneration } from "./pending-generation";

const requestId = "1b292510-9536-4c32-9964-6dca4adfcad1";

describe("parsePendingGeneration", () => {
  it("persists and clears the request used for a charged brief", () => {
    const pending = { requestId, userId: "user-1", campaignId: null, startedAt: 123 };
    expect(savePendingGeneration(pending)).toBe(true);
    expect(parsePendingGeneration(sessionStorage.getItem(PENDING_GENERATION_KEY))).toEqual(pending);
    clearPendingGeneration();
    expect(sessionStorage.getItem(PENDING_GENERATION_KEY)).toBeNull();
  });

  it("keeps the original request identity across a page reload", () => {
    expect(parsePendingGeneration(JSON.stringify({
      requestId, userId: "user-1", campaignId: null, startedAt: 123,
    }))).toEqual({ requestId, userId: "user-1", campaignId: null, startedAt: 123 });
  });

  it("rejects malformed or incomplete recovery records", () => {
    expect(parsePendingGeneration("{")).toBeNull();
    expect(parsePendingGeneration(JSON.stringify({ requestId: "bad", userId: "user-1", campaignId: null, startedAt: 123 }))).toBeNull();
    expect(parsePendingGeneration(JSON.stringify({ requestId, startedAt: 123 }))).toBeNull();
  });
});
