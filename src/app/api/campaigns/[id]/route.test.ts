import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, tenantFor, getCampaign, getBriefVersions, finalizeBriefVersion, economicsForBrief } = vi.hoisted(() => ({
  economicsForBrief: vi.fn(),
  requireUser: vi.fn(),
  tenantFor: vi.fn(),
  getCampaign: vi.fn(),
  getBriefVersions: vi.fn(),
  finalizeBriefVersion: vi.fn(),
}));
vi.mock("@/lib/api/require-user", () => ({ requireUser }));
vi.mock("@/modules/campaigns/repository", () => ({ tenantFor, getCampaign, getBriefVersions, finalizeBriefVersion }));
vi.mock("@/modules/economics/brief-run", () => ({ economicsForBrief }));

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
    tenantFor.mockReset().mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
    getCampaign.mockReset().mockResolvedValue({
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
    getCampaign.mockResolvedValue({
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
    getCampaign.mockResolvedValue({
      id: "campaign-1",
      brief_data: { storeInsights: { store: { currency: "USD" } }, budget_plan: { max_total_budget: 700 } },
    });
    const response = await put({ versionId: "version-1", briefData: { maxTestBudget: null } });
    expect(response.status).toBe(200);
    expect(savedContext().budget_plan).toMatchObject({ basis: "not_set", max_total_budget: null, daily_cap: null });
  });
});

describe("PUT /api/campaigns/[id] — Phase 4 economics", () => {
  const ENGINE = { version: 1, status: "computed", verdict: "PILOT", currency: "NGN", run_id: "run-1", product_id: 42 };
  beforeEach(() => {
    requireUser.mockReset().mockResolvedValue({ ok: true, userId: "user-1" });
    tenantFor.mockReset().mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
    getBriefVersions.mockReset().mockResolvedValue([{ id: "version-1", is_selected: true }]);
    finalizeBriefVersion.mockReset().mockResolvedValue(undefined);
    economicsForBrief.mockReset().mockResolvedValue(ENGINE);
  });

  it("recomputes on the server for the saved product, with the merchant's limit, and never stores client figures", async () => {
    getCampaign.mockReset().mockResolvedValue({ id: "campaign-1", brief_data: { productShopifyId: 42 } });
    const response = await put({ versionId: "version-1", briefData: {
      selectedDuration: 30, maxTestBudget: "500", productShopifyId: 999,
      economics: { version: 1, status: "computed", verdict: "GO", budget: { status: "recommended", test_budget: 1e9 } },
      budget_plan: { daily_cap: 999999 },
    } });
    expect(response.status).toBe(200);
    expect(economicsForBrief).toHaveBeenCalledWith({ userId: "user-1", productId: 42, testDays: 30, testLimit: 500 });
    const context = savedContext();
    expect(context.economics).toEqual(ENGINE);
    expect(context.productShopifyId).toBe(42);
    expect(context).not.toHaveProperty("budget_plan");
    expect(context).not.toHaveProperty("maxTestBudget");
    expect(await response.json()).toMatchObject({ ok: true, economics: ENGINE });
  });

  it("leaves the product's limit unchanged when none is sent, and clears it when emptied", async () => {
    getCampaign.mockReset().mockResolvedValue({ id: "campaign-1", brief_data: { productShopifyId: 42 } });
    await put({ versionId: "version-1", briefData: { selectedDuration: 14 } });
    expect(economicsForBrief.mock.calls[0][0]).toMatchObject({ testLimit: undefined });
    await put({ versionId: "version-1", briefData: { selectedDuration: 14, maxTestBudget: "" } });
    expect(economicsForBrief.mock.calls[1][0]).toMatchObject({ testLimit: null });
    expect((await put({ versionId: "version-1", briefData: { maxTestBudget: "-5" } })).status).toBe(400);
  });

  it("keeps the S0.6 plan for briefs saved before Phase 4, and drops any client-sent economics", async () => {
    getCampaign.mockReset().mockResolvedValue({ id: "campaign-1", brief_data: { storeInsights: { store: { currency: "USD" } } } });
    await put({ versionId: "version-1", briefData: { selectedDuration: 14, maxTestBudget: 140, economics: { version: 1, status: "computed" } } });
    expect(economicsForBrief).not.toHaveBeenCalled();
    const context = savedContext();
    expect(context).not.toHaveProperty("economics");
    expect(context.budget_plan).toMatchObject({ basis: "merchant_cap", max_total_budget: 140, daily_cap: 10 });
  });
});
