import { beforeEach, describe, expect, it, vi } from "vitest";

const supabase = vi.hoisted(() => {
  const state = {
    row: {} as Record<string, unknown> | null,
    rpc: vi.fn(),
    updates: [] as Record<string, unknown>[],
  };
  const builder = () => {
    const query: Record<string, unknown> = {};
    const chain = () => query;
    Object.assign(query, {
      select: chain,
      eq: chain,
      order: chain,
      limit: async () => ({ data: state.row ? [state.row] : [], error: null }),
      maybeSingle: async () => ({ data: state.row, error: null }),
      update: (data: Record<string, unknown>) => {
        state.updates.push(data);
        return { eq: async () => ({ error: null }) };
      },
    });
    return query;
  };
  return { state, builder };
});

vi.mock("@/platform/supabase", () => ({
  supabaseAdmin: { rpc: supabase.state.rpc, from: supabase.builder },
}));
vi.mock("./shopify-token", () => ({ getValidShopifyToken: vi.fn() }));

import { addCreditsToIntegration, addCreditsToUser, handleFreeCreditOnInstall } from "./billing-db";
import { grantFreeCredit, incrementCredits } from "./db";

const missingRpc = { data: null, error: { code: "PGRST202", message: "not found" } };

beforeEach(() => {
  supabase.state.updates = [];
  supabase.state.row = { clerk_user_id: "u1", credits: 4, credits_balance: 4, credits_total_purchased: 10, free_credit_used: false };
  supabase.state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("credit grants (DATA-02)", () => {
  it("adds purchased credits through the atomic RPC, with no read-modify-write", async () => {
    supabase.state.rpc.mockResolvedValue({ data: 7, error: null });
    await expect(addCreditsToUser("u1", 3)).resolves.toBe(7);
    expect(supabase.state.rpc).toHaveBeenCalledWith("add_user_credits", { p_user_id: "u1", p_credits: 3, p_purchased: 3 });
    expect(supabase.state.updates).toEqual([]);
  });

  it("surfaces a database failure so the payment claim can be released", async () => {
    supabase.state.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "integration_not_found" } });
    await expect(addCreditsToUser("u1", 3)).rejects.toMatchObject({ message: "integration_not_found" });
  });

  it("before migration 0014 is applied, still writes both balance columns", async () => {
    supabase.state.rpc.mockResolvedValue(missingRpc);
    await expect(incrementCredits("u1", 3, 3)).resolves.toBe(7);
    expect(supabase.state.updates[0]).toEqual({ credits_balance: 7, credits: 7, credits_total_purchased: 13 });
  });

  it("legacy shop-keyed grants credit the shop's owner atomically", async () => {
    supabase.state.rpc.mockResolvedValue({ data: 9, error: null });
    await addCreditsToIntegration("s.myshopify.com", 5);
    expect(supabase.state.rpc).toHaveBeenCalledWith("add_user_credits", { p_user_id: "u1", p_credits: 5, p_purchased: 5 });
  });

  it("a purchase for an unknown shop throws instead of being silently lost", async () => {
    supabase.state.row = null;
    await expect(addCreditsToIntegration("nobody.myshopify.com", 5)).rejects.toThrow(/No integration/);
    expect(supabase.state.rpc).not.toHaveBeenCalled();
  });
});

describe("free install credit (DATA-02)", () => {
  it("is granted through the one-time RPC", async () => {
    supabase.state.rpc.mockResolvedValue({ data: true, error: null });
    await handleFreeCreditOnInstall("u1");
    expect(supabase.state.rpc).toHaveBeenCalledWith("grant_free_credit", { p_user_id: "u1" });
    expect(supabase.state.updates).toEqual([]);
  });

  it("is added to an existing balance, never set to 1 (before 0014 too)", async () => {
    supabase.state.rpc.mockResolvedValue(missingRpc);
    await expect(grantFreeCredit("u1")).resolves.toBe(true);
    expect(supabase.state.updates[0]).toMatchObject({ credits: 5, credits_balance: 5 });
    expect(supabase.state.updates[1]).toEqual({ free_credit_used: true });
  });

  it("is not granted twice (before 0014 too)", async () => {
    supabase.state.rpc.mockResolvedValue(missingRpc);
    supabase.state.row = { ...supabase.state.row, free_credit_used: true };
    await expect(grantFreeCredit("u1")).resolves.toBe(false);
    expect(supabase.state.updates).toEqual([]);
  });
});
