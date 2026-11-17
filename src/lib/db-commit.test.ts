import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/platform/supabase", () => ({ supabaseAdmin: { rpc, from } }));

import { commitBriefGeneration, isBriefRegenerationCommitReady, logApiUsage } from "./db";

const params = {
  p_workspace: "00000000-0000-4000-8000-0000000000aa",
  p_user_id: "user-1",
  p_request_id: "00000000-0000-4000-8000-000000000001",
  p_request_hash: "hash",
  p_campaign_id: null,
  p_campaign: {},
  p_copy: {},
  p_context: {},
  p_response: {},
};

describe("commitBriefGeneration", () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it("returns the atomic RPC result", async () => {
    const receipt = { campaignId: "campaign-1", versionId: "version-1" };
    rpc.mockResolvedValue({ data: receipt, error: null });
    await expect(commitBriefGeneration(params)).resolves.toEqual(receipt);
    expect(from).not.toHaveBeenCalled();
  });

  it("fails closed when the RPC errors instead of issuing separate writes", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "database unavailable", code: "08006" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(commitBriefGeneration(params)).rejects.toThrow("Could not confirm the brief was saved");
      expect(from).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("rejects an incomplete RPC result", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(commitBriefGeneration(params)).rejects.toThrow("Could not confirm the brief was saved");
      expect(from).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe("isBriefRegenerationCommitReady", () => {
  beforeEach(() => from.mockReset());

  it("allows regeneration only after its save migration is recorded", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "0010_fix_commit_brief_ambiguity" }, error: null,
      }),
    };
    from.mockReturnValue(query);

    await expect(isBriefRegenerationCommitReady()).resolves.toBe(true);
    expect(from).toHaveBeenCalledWith("schema_migrations");
    expect(query.eq).toHaveBeenCalledWith("id", "0010_fix_commit_brief_ambiguity");

    query.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(isBriefRegenerationCommitReady()).resolves.toBe(false);
  });

  it("stops regeneration when migration status cannot be verified", async () => {
    from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "unavailable", code: "08006" } }),
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(isBriefRegenerationCommitReady()).resolves.toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

it("records cached tokens in the full usage total", async () => {
  const insert = vi.fn().mockResolvedValue({ error: null });
  from.mockReset().mockReturnValue({ insert });

  await logApiUsage("user-1", "brief_generation", {
    input_tokens: 1,
    cache_creation_input_tokens: 250,
    cache_read_input_tokens: 4000,
    output_tokens: 300,
  }, "claude-sonnet-5");

  expect(from).toHaveBeenCalledWith("api_usage_log");
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({
    input_tokens: 1,
    cache_creation_input_tokens: 250,
    cache_read_input_tokens: 4000,
    output_tokens: 300,
    total_tokens: 4551,
    model: "claude-sonnet-5",
  }));
});
