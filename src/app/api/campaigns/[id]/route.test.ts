import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getCampaignById, getBriefVersions, finalizeBriefVersion } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getCampaignById: vi.fn(),
  getBriefVersions: vi.fn(),
  finalizeBriefVersion: vi.fn(),
}));
vi.mock("@/lib/api/require-user", () => ({ requireUser }));
vi.mock("@/lib/db", () => ({ getCampaignById, getBriefVersions, finalizeBriefVersion }));

import { PUT } from "./route";

const params = { params: Promise.resolve({ id: "campaign-1" }) };
const put = (body: unknown) =>
  PUT(
    new Request("http://localhost/api/campaigns/campaign-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  );
const savedContext = () => finalizeBriefVersion.mock.calls[0][3] as Record<string, unknown>;

describe("PUT /api/campaigns/[id] — merchant test budget (S0.6)", () => {
  beforeEach(() => {
    requireUser.mockReset().mockResolvedValue({ ok: true, userId: "user-1" });
    getCampaignById.mockReset().mockResolvedValue({
      id: "campaign-1",
      brief_data: { storeInsights: { store: { currency: "NGN", currency_symbol: "₦" } } },
    });
    getBriefVersions.mockReset().mockResolvedValue([{ id: "version-1", is_selected: true }]);
    finalizeBriefVersion.mockReset().mockResolvedValue(undefined);
  });

  it("computes the plan on the server from the merchant's cap and the stored currency", async () => {
    const response = await put({
      versionId: "version-1",
      briefData: {
        selectedDuration: 14,
        maxTestBudget: 280000,
        // Client-sent amounts must never be stored as-is.
        budget_plan: { daily_cap: 999999, currency: "USD", max_total_budget: 1 },
      },
    });
    expect(response.status).toBe(200);
    const context = savedContext();
    expect(context.budget_plan).toMatchObject({
      basis: "merchant_cap",
      currency: "NGN",
      currency_symbol: "₦",
      max_total_budget: 280000,
      duration_days: 14,
      daily_cap: 20000,
    });
    expect(context).not.toHaveProperty("maxTestBudget");
  });

  it("rejects an invalid cap without saving", async () => {
    for (const maxTestBudget of [-50, "-50", "1e5", 0, "abc"]) {
      finalizeBriefVersion.mockClear();
      const response = await put({ versionId: "version-1", briefData: { maxTestBudget } });
      expect(response.status).toBe(400);
      expect(finalizeBriefVersion).not.toHaveBeenCalled();
    }
  });

  it("keeps the campaign's saved cap when a caller does not send one (e.g. saving a new variation)", async () => {
    getCampaignById.mockResolvedValue({
      id: "campaign-1",
      brief_data: {
        storeInsights: { store: { currency: "USD" } },
        budget_plan: { max_total_budget: 700, duration_days: 14 },
      },
    });
    const response = await put({ versionId: "version-1", briefData: { selectedDuration: 7 } });
    expect(response.status).toBe(200);
    expect(savedContext().budget_plan).toMatchObject({ max_total_budget: 700, duration_days: 7, daily_cap: 100 });
  });

  it("clears the cap when the merchant empties the field", async () => {
    getCampaignById.mockResolvedValue({
      id: "campaign-1",
      brief_data: { storeInsights: { store: { currency: "USD" } }, budget_plan: { max_total_budget: 700 } },
    });
    const response = await put({ versionId: "version-1", briefData: { maxTestBudget: null } });
    expect(response.status).toBe(200);
    expect(savedContext().budget_plan).toMatchObject({ basis: "not_set", max_total_budget: null, daily_cap: null });
  });
});
