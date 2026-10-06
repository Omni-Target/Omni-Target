import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc, from }) }));

import { commitBriefGeneration, getGenerationReceipt, getGenerationReceiptById, isBriefRegenerationCommitReady, logApiUsage, saveRecoveredCreativeHooks } from "./db";

const params = {
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

describe("getGenerationReceiptById", () => {
  beforeEach(() => from.mockReset());

  it("returns only the signed-in user's completed request", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { response: { campaignId: "campaign-1" } }, error: null }),
    };
    from.mockReturnValue(query);
    await expect(getGenerationReceiptById("user-1", params.p_request_id)).resolves.toEqual({ campaignId: "campaign-1" });
    expect(query.eq).toHaveBeenCalledWith("clerk_user_id", "user-1");
    expect(query.eq).toHaveBeenCalledWith("request_id", params.p_request_id);
  });

  it("does not treat a database error as a missing receipt", async () => {
    from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "unavailable", code: "08006" } }),
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(getGenerationReceiptById("user-1", params.p_request_id)).rejects.toThrow("Could not check whether the brief was saved");
    } finally {
      log.mockRestore();
    }
  });
});

it("blocks generation if the prior receipt cannot be checked", async () => {
  rpc.mockReset();
  from.mockReset().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "unavailable", code: "08006" } }),
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(getGenerationReceipt("user-1", params.p_request_id, "hash")).rejects.toThrow("Could not verify prior generation request");
    expect(rpc).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
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

it("saves recovered hooks only on the authenticated campaign version and preserves its generation context", async () => {
  const read = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { brief_data: { generatedCopy: { headline: "Saved" } } }, error: null }),
  };
  const write = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: "version-1" }, error: null }),
  };
  from.mockReset().mockReturnValueOnce(read).mockReturnValueOnce(write);
  const hooks = [{ angle: "Material / Craftsmanship", visual_cue: "Show seams", on_screen_text: "Sewn by hand", primary_text_hook: "See the stitches." }];

  await saveRecoveredCreativeHooks("user-1", "campaign-1", "version-1", hooks);

  expect(read.eq.mock.calls).toEqual([
    ["id", "version-1"], ["campaign_id", "campaign-1"], ["clerk_user_id", "user-1"],
  ]);
  expect(write.update).toHaveBeenCalledWith({
    brief_data: { generatedCopy: { headline: "Saved" }, recovered_creative_hooks: hooks },
  });
  expect(write.eq.mock.calls).toEqual(read.eq.mock.calls);
});
