import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { rpc: vi.fn(), updates: [] as Record<string, unknown>[], deleted: [] as string[] };
  const from = (table: string) => ({
    update: (data: Record<string, unknown>) => {
      state.updates.push(data);
      return { or: async () => ({ error: null }) };
    },
    delete: () => ({
      eq: async () => {
        state.deleted.push(table);
        return { error: null };
      },
    }),
    select: () => ({ limit: async () => ({ error: null }) }),
  });
  return { state, from };
});
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: h.state.rpc, from: h.from }),
}));

import { deleteUserData, redactShopData, revokeShopAccess } from "./db";

const missing = { error: { code: "PGRST202", message: "not found" } };
beforeEach(() => {
  h.state.rpc.mockReset();
  h.state.updates = [];
  h.state.deleted = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("shop redaction (SEC-09)", () => {
  it("runs the full redaction in one database call", async () => {
    h.state.rpc.mockResolvedValue({ error: null });
    await expect(redactShopData("s.myshopify.com")).resolves.toBe(true);
    expect(h.state.rpc).toHaveBeenCalledWith("redact_shop_data", { p_shop: "s.myshopify.com", p_tokens_only: false });
  });

  it("revokes only credentials on uninstall", async () => {
    h.state.rpc.mockResolvedValue({ error: null });
    await revokeShopAccess("s.myshopify.com");
    expect(h.state.rpc).toHaveBeenCalledWith("redact_shop_data", { p_shop: "s.myshopify.com", p_tokens_only: true });
  });

  it("reports failure without throwing, so the webhook can still answer 200", async () => {
    h.state.rpc.mockResolvedValue({ error: { code: "XX000", message: "boom" } });
    await expect(redactShopData("s.myshopify.com")).resolves.toBe(false);
  });

  it("before migration 0016, still clears both sets of token columns", async () => {
    h.state.rpc.mockResolvedValue(missing);
    await redactShopData("s.myshopify.com");
    expect(h.state.updates[0]).toMatchObject({ shopify_access_token: null, shopify_refresh_token: null, store_snapshot: null });
  });

  it("before migration 0016, uninstall leaves the snapshot in place", async () => {
    h.state.rpc.mockResolvedValue(missing);
    await revokeShopAccess("s.myshopify.com");
    expect(h.state.updates[0]).not.toHaveProperty("store_snapshot");
  });
});

describe("account deletion (SEC-09)", () => {
  it("deletes through the all-tables function", async () => {
    h.state.rpc.mockResolvedValue({ error: null });
    await deleteUserData("u1");
    expect(h.state.rpc).toHaveBeenCalledWith("delete_user_data", { p_user_id: "u1" });
    expect(h.state.deleted).toEqual([]);
  });

  it("surfaces database errors so the Clerk user is not deleted first", async () => {
    h.state.rpc.mockResolvedValue({ error: { code: "XX000", message: "boom" } });
    await expect(deleteUserData("u1")).rejects.toMatchObject({ message: "boom" });
  });
});
