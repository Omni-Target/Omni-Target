import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ forWorkspace: vi.fn(), forShop: vi.fn(), current: vi.fn() }));
vi.mock("@/modules/credentials/shopify", () => ({ getShopifyAccessForWorkspace: m.forWorkspace, getShopifyAccessForShop: m.forShop }));
vi.mock("@/modules/workspaces/current", () => ({ currentWorkspaceFor: m.current }));

import { getShopifyTokenForShop, getValidShopifyToken } from "./shopify-token";

const ok = { status: "ok", accessToken: "token", shopUrl: "s.myshopify.com" } as const;

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.forWorkspace.mockResolvedValue(ok);
  m.forShop.mockResolvedValue(ok);
});

describe("getValidShopifyToken (task 4)", () => {
  it("issues the token of the user's current workspace, as that user", async () => {
    m.current.mockResolvedValue({ workspace_id: "ws-current", status: "active", shop_domain: "s.myshopify.com" });
    expect(await getValidShopifyToken("user_a")).toEqual(ok);
    expect(m.current).toHaveBeenCalledWith("user_a");
    expect(m.forWorkspace).toHaveBeenCalledWith("ws-current", "user_a");
  });

  it("uses an explicitly named workspace, still checked against the user by the database", async () => {
    await getValidShopifyToken("user_a", "ws-named");
    expect(m.current).not.toHaveBeenCalled();
    expect(m.forWorkspace).toHaveBeenCalledWith("ws-named", "user_a");
  });

  it("issues nothing for a user without a workspace", async () => {
    m.current.mockResolvedValue(null);
    expect(await getValidShopifyToken("user_a")).toEqual({ status: "not_connected" });
    expect(m.forWorkspace).not.toHaveBeenCalled();
  });

  it("serves system work by shop", async () => {
    expect(await getShopifyTokenForShop("s.myshopify.com")).toEqual(ok);
    expect(m.forShop).toHaveBeenCalledWith("s.myshopify.com");
  });
});
