import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getGenerationReceiptById } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getGenerationReceiptById: vi.fn(),
}));
vi.mock("@/lib/api/require-user", () => ({ requireUser }));
vi.mock("@/lib/db", () => ({ getGenerationReceiptById }));

import { GET } from "./route";

const requestId = "1b292510-9536-4c32-9964-6dca4adfcad1";
const request = () => new Request(`http://localhost/api/campaigns/generate/receipt?requestId=${requestId}`);

describe("generation receipt recovery", () => {
  beforeEach(() => {
    requireUser.mockReset().mockResolvedValue({ ok: true, userId: "user-1" });
    getGenerationReceiptById.mockReset();
  });

  it("waits without making a new generation when the receipt is not committed yet", async () => {
    getGenerationReceiptById.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(getGenerationReceiptById).toHaveBeenCalledWith("user-1", requestId);
  });

  it("returns the saved result for its owner", async () => {
    getGenerationReceiptById.mockResolvedValue({ campaignId: "campaign-1", versionId: "version-2" });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).receipt.versionId).toBe("version-2");
  });

  it("reports a database failure instead of treating it as an unsaved brief", async () => {
    getGenerationReceiptById.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(request());
    expect(response.status).toBe(503);
  });

  it("does not read receipts without authentication", async () => {
    requireUser.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(getGenerationReceiptById).not.toHaveBeenCalled();
  });
});
