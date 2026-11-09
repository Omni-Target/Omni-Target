import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class WorkspaceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    WorkspaceError,
    auth: vi.fn(),
    listWorkspaces: vi.fn(),
    disconnectWorkspace: vi.fn(),
    clearCredentials: vi.fn(),
    requestTransfer: vi.fn(),
    listTransfers: vi.fn(),
    approveTransfer: vi.fn(),
    cancelTransfer: vi.fn(),
  };
});

vi.mock("@clerk/nextjs/server", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ disconnectShopInstallation: h.clearCredentials }));
vi.mock("@/modules/workspaces/repository", () => ({
  WorkspaceError: h.WorkspaceError,
  listWorkspaces: h.listWorkspaces,
  disconnectWorkspace: h.disconnectWorkspace,
  requestOwnershipTransfer: h.requestTransfer,
  listTransfersForActor: h.listTransfers,
  approveOwnershipTransfer: h.approveTransfer,
  cancelOwnershipTransfer: h.cancelTransfer,
}));

import { GET as listRoute } from "./route";
import { POST as disconnectRoute } from "./[id]/disconnect/route";
import { GET as listTransfersRoute, POST as requestTransferRoute } from "./transfers/route";
import { POST as approveRoute } from "./transfers/[id]/approve/route";
import { POST as cancelRoute } from "./transfers/[id]/cancel/route";

const WS = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const TR = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) => new Request("http://localhost/api", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const mocks = [h.auth, h.listWorkspaces, h.disconnectWorkspace, h.clearCredentials, h.requestTransfer, h.listTransfers, h.approveTransfer, h.cancelTransfer];

beforeEach(() => {
  for (const fn of mocks) fn.mockReset();
  h.auth.mockResolvedValue({ userId: "user_a" });
  h.clearCredentials.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("workspace routes require a signed-in user", () => {
  it("answers 401 without touching the database", async () => {
    h.auth.mockResolvedValue({ userId: null });
    const responses = await Promise.all([
      listRoute(),
      disconnectRoute(post(), ctx(WS)),
      listTransfersRoute(),
      requestTransferRoute(post({ shop: "s.myshopify.com" })),
      approveRoute(post(), ctx(TR)),
      cancelRoute(post(), ctx(TR)),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(h.listWorkspaces).not.toHaveBeenCalled();
    expect(h.disconnectWorkspace).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspaces", () => {
  it("lists the session user's workspaces", async () => {
    h.listWorkspaces.mockResolvedValue([{ workspace_id: WS, status: "active", shop_domain: "s.myshopify.com" }]);
    const response = await listRoute();
    expect(await response.json()).toEqual({ workspaces: [{ workspace_id: WS, status: "active", shop_domain: "s.myshopify.com" }] });
    expect(h.listWorkspaces).toHaveBeenCalledWith("user_a");
  });
});

describe("POST /api/workspaces/[id]/disconnect", () => {
  it("disconnects as the session user and clears the store's credential", async () => {
    h.disconnectWorkspace.mockResolvedValue({ outcome: "disconnected", workspace_id: WS, shop_domain: "s.myshopify.com" });
    const response = await disconnectRoute(post(), ctx(WS));
    expect(response.status).toBe(200);
    expect(h.disconnectWorkspace).toHaveBeenCalledWith(WS, "user_a");
    expect(h.clearCredentials).toHaveBeenCalledWith("s.myshopify.com");
  });

  it("finishes a credential clear on a repeated request", async () => {
    h.disconnectWorkspace.mockResolvedValue({ outcome: "not_active", status: "disconnected", shop_domain: "s.myshopify.com" });
    await disconnectRoute(post(), ctx(WS));
    expect(h.clearCredentials).toHaveBeenCalledWith("s.myshopify.com");
  });

  it("clears nothing for a workspace that is uninstalled or being deleted", async () => {
    h.disconnectWorkspace.mockResolvedValue({ outcome: "not_active", status: "pending_deletion", shop_domain: "s.myshopify.com" });
    await disconnectRoute(post(), ctx(WS));
    expect(h.clearCredentials).not.toHaveBeenCalled();
  });

  it("hides another user's workspace and malformed ids behind 404", async () => {
    h.disconnectWorkspace.mockRejectedValue(new h.WorkspaceError("workspace_access_denied"));
    expect((await disconnectRoute(post(), ctx(WS))).status).toBe(404);
    expect((await disconnectRoute(post(), ctx("not-a-uuid"))).status).toBe(404);
    expect(h.clearCredentials).not.toHaveBeenCalled();
  });

  it("answers 500 when the credential could not be cleared", async () => {
    h.disconnectWorkspace.mockResolvedValue({ outcome: "disconnected", shop_domain: "s.myshopify.com" });
    h.clearCredentials.mockResolvedValue(false);
    expect((await disconnectRoute(post(), ctx(WS))).status).toBe(500);
  });
});

describe("ownership transfer routes", () => {
  it("requests a transfer as the session user and returns the Shopify verification link", async () => {
    h.requestTransfer.mockResolvedValue({ outcome: "requested", transfer_id: TR });
    const response = await requestTransferRoute(post({ shop: " S.myshopify.com ", reason: "Bought the business", userId: "user_owner" }));
    expect(response.status).toBe(201);
    expect(h.requestTransfer).toHaveBeenCalledWith({ domain: "s.myshopify.com", requester: "user_a", targetWorkspaceId: null, reason: "Bought the business" });
    const body = await response.json();
    expect(body.verifyUrl).toBe(`/api/auth/shopify/connect?shop=s.myshopify.com&from=dashboard&transfer=${TR}`);
  });

  it("rejects a malformed request", async () => {
    for (const body of [null, {}, { shop: "evil.example.com" }, { shop: "s.myshopify.com", workspaceId: "x" }]) {
      expect((await requestTransferRoute(post(body))).status).toBe(400);
    }
    expect(h.requestTransfer).not.toHaveBeenCalled();
  });

  it("reports a refused request as a conflict", async () => {
    h.requestTransfer.mockRejectedValue(new h.WorkspaceError("transfer_already_open"));
    const response = await requestTransferRoute(post({ shop: "s.myshopify.com" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "transfer_already_open" });
  });

  it("approves and cancels only as the session user", async () => {
    h.approveTransfer.mockResolvedValue({ outcome: "approved" });
    h.cancelTransfer.mockResolvedValue({ outcome: "cancelled" });
    expect((await approveRoute(post(), ctx(TR))).status).toBe(200);
    expect(h.approveTransfer).toHaveBeenCalledWith(TR, "user_a");
    expect((await cancelRoute(post(), ctx(TR))).status).toBe(200);
    expect(h.cancelTransfer).toHaveBeenCalledWith(TR, "user_a");
  });

  it("hides transfers the user may not act on, and reports ones not ready", async () => {
    h.approveTransfer.mockRejectedValueOnce(new h.WorkspaceError("transfer_access_denied"));
    expect((await approveRoute(post(), ctx(TR))).status).toBe(404);
    h.approveTransfer.mockRejectedValueOnce(new h.WorkspaceError("transfer_not_approvable"));
    expect((await approveRoute(post(), ctx(TR))).status).toBe(409);
  });

  it("lists the session user's transfers", async () => {
    h.listTransfers.mockResolvedValue([]);
    await listTransfersRoute();
    expect(h.listTransfers).toHaveBeenCalledWith("user_a");
  });
});
