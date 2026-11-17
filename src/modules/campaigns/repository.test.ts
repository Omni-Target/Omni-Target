import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), currentWorkspaceFor: vi.fn() }));
vi.mock("@/platform/supabase", () => ({ supabaseAdmin: { from: m.from, rpc: m.rpc } }));
vi.mock("@/modules/workspaces/current", () => ({ currentWorkspaceFor: m.currentWorkspaceFor }));

import {
  creatorHasAnyCampaign,
  finalizeBriefVersion,
  getBriefVersions,
  getCampaign,
  getGenerationReceipt,
  getGenerationReceiptById,
  listBriefCampaigns,
  saveRecoveredCreativeHooks,
  tenantFor,
} from "./repository";

const ctx = { userId: "user-1", workspaceId: "ws-1" };

/** A chainable query that records every filter and resolves to `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> & { eqs: [string, unknown][] } = { eqs: [] };
  for (const method of ["select", "update", "in", "not", "order", "limit"]) q[method] = vi.fn(() => q);
  q.eq = vi.fn((column: string, value: unknown) => { q.eqs.push([column, value]); return q; });
  q.maybeSingle = vi.fn(async () => result);
  q.single = vi.fn(async () => result);
  q.then = (resolve: (v: unknown) => void) => resolve(result);
  return q;
}
const guarded = (q: { eqs: [string, unknown][] }) =>
  expect(q.eqs).toEqual(expect.arrayContaining([["workspace_id", "ws-1"], ["clerk_user_id", "user-1"]]));

beforeEach(() => {
  m.from.mockReset();
  m.rpc.mockReset();
  m.currentWorkspaceFor.mockReset();
});

describe("tenant guard (Phase 1 task 7)", () => {
  it("derives the tenant from the session user's current workspace, or none", async () => {
    m.currentWorkspaceFor.mockResolvedValueOnce({ workspace_id: "ws-1", status: "active", shop_domain: null }).mockResolvedValueOnce(null);
    await expect(tenantFor("user-1")).resolves.toEqual(ctx);
    await expect(tenantFor("user-1")).resolves.toBeNull();
  });

  it("scopes every campaign read to both the workspace and the creator", async () => {
    const campaign = query({ data: { id: "c-1" }, error: null });
    m.from.mockReturnValueOnce(campaign);
    await getCampaign(ctx, "c-1");
    guarded(campaign);

    const versions = query({ data: [], error: null });
    m.from.mockReturnValueOnce(versions);
    await getBriefVersions(ctx, "c-1");
    guarded(versions);

    const list = query({ data: [{ id: "c-1" }], error: null });
    const counts = query({ data: [{ campaign_id: "c-1" }, { campaign_id: "c-1" }], error: null });
    m.from.mockReturnValueOnce(list).mockReturnValueOnce(counts);
    await expect(listBriefCampaigns(ctx)).resolves.toEqual([{ id: "c-1", variation_count: 2 }]);
    guarded(list);
    guarded(counts);
  });

  it("lets the nudge cron check a creator's briefs across workspaces, failing loudly", async () => {
    const found = query({ data: [{ id: "c-1" }], error: null });
    m.from.mockReturnValueOnce(found).mockReturnValueOnce(query({ data: [], error: null })).mockReturnValueOnce(query({ data: null, error: { message: "down" } }));
    await expect(creatorHasAnyCampaign("user-1")).resolves.toBe(true);
    expect(found.eqs).toEqual([["clerk_user_id", "user-1"]]);
    await expect(creatorHasAnyCampaign("user-1")).resolves.toBe(false);
    await expect(creatorHasAnyCampaign("user-1")).rejects.toThrow();
  });

  it("ignores a generation receipt from another of the user's workspaces", async () => {
    m.from.mockReturnValue(query({ data: { request_hash: "h", response: { campaignId: "c-9" }, workspace_id: "ws-other" }, error: null }));
    await expect(getGenerationReceiptById(ctx, "r-1")).resolves.toBeNull();
    await expect(getGenerationReceipt(ctx, "r-1", "h")).resolves.toBeNull();
  });

  it("returns the user's own receipt, rejects a changed request, and never treats a database error as no receipt", async () => {
    m.from.mockReturnValue(query({ data: { request_hash: "h", response: { campaignId: "c-1" }, workspace_id: "ws-1" }, error: null }));
    await expect(getGenerationReceiptById(ctx, "r-1")).resolves.toEqual({ campaignId: "c-1" });
    await expect(getGenerationReceipt(ctx, "r-1", "other")).rejects.toThrow("idempotency_conflict");
    m.from.mockReturnValue(query({ data: null, error: { message: "down" } }));
    await expect(getGenerationReceipt(ctx, "r-1", "h")).rejects.toThrow("Could not check the generation receipt.");
  });

  it("refuses to finalize a campaign outside the workspace, without calling the database function", async () => {
    m.from.mockReturnValue(query({ data: null, error: null }));
    await expect(finalizeBriefVersion(ctx, "c-9", "v-1", {}, {})).rejects.toThrow("campaign_not_found");
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("saves recovered hooks only on this creator's version in this workspace, keeping its generation context", async () => {
    const read = query({ data: { brief_data: { generatedCopy: { headline: "Saved" } } }, error: null });
    const write = query({ data: { id: "v-1" }, error: null });
    m.from.mockReturnValueOnce(read).mockReturnValueOnce(write);
    const hooks = [{ angle: "Craft", visual_cue: "Seams", on_screen_text: "Hand sewn", primary_text_hook: "See the stitches." }];
    await saveRecoveredCreativeHooks(ctx, "c-1", "v-1", hooks);
    guarded(read);
    guarded(write);
    expect(write.update).toHaveBeenCalledWith({ brief_data: { generatedCopy: { headline: "Saved" }, recovered_creative_hooks: hooks } });
  });
});
