import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  upsertUserIntegration: vi.fn(),
  fetchWithRetry: vi.fn(),
  fetch: vi.fn(),
  storeMetaConnection: vi.fn(),
  currentWorkspaceFor: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: m.auth }));
vi.mock("@/modules/credentials/meta", () => ({ storeMetaConnection: m.storeMetaConnection }));
vi.mock("@/modules/workspaces/current", () => ({ currentWorkspaceFor: m.currentWorkspaceFor }));
vi.mock("@/lib/db", () => ({ upsertUserIntegration: m.upsertUserIntegration }));
vi.mock("@/lib/http", () => ({ fetchWithRetry: m.fetchWithRetry }));

import { GET as connect } from "./connect/route";
import { GET as callback } from "./callback/route";

const APP = "https://app.test";
const NONCE = "a".repeat(64);

function callbackRequest(query: Record<string, string>, cookie?: string) {
  return new NextRequest(`${APP}/api/auth/meta/callback?${new URLSearchParams(query)}`, {
    headers: cookie ? { cookie } : {},
  });
}

function setCookies(response: Response): string[] {
  const h = response.headers as Headers & { getSetCookie?: () => string[] };
  return h.getSetCookie ? h.getSetCookie() : [h.get("set-cookie") || ""];
}

beforeEach(() => {
  process.env.META_APP_ID = "meta-app";
  process.env.META_APP_SECRET = "meta-secret";
  for (const fn of Object.values(m)) fn.mockReset();
  m.auth.mockResolvedValue({ userId: "user_victim" });
  m.currentWorkspaceFor.mockResolvedValue({ workspace_id: "ws-current", status: "active", shop_domain: "s.myshopify.com" });
  m.fetch.mockResolvedValue(Response.json({ access_token: "EAAB-attacker-token" }));
  m.fetchWithRetry.mockImplementation(async (url: string) =>
    url.includes("adaccounts")
      ? Response.json({ data: [{ id: "act_1", account_status: 1, user_tasks: ["ADVERTISE"], adspixels: { data: [{ id: "px_attacker" }] } }] })
      : Response.json({ data: [] }),
  );
  vi.stubGlobal("fetch", m.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Meta OAuth callback — SEC-04 CSRF", () => {
  it("rejects a crafted callback with the attacker's code when this browser has no state cookie", async () => {
    const res = await callback(callbackRequest({ code: "attacker-code", state: "user_victim" }));
    const location = new URL(res.headers.get("location")!);
    expect(`${location.pathname}${location.search}`).toBe("/settings?meta=error");
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });

  it("rejects a state that does not match this browser's cookie", async () => {
    const res = await callback(callbackRequest({ code: "attacker-code", state: "b".repeat(64) }, `meta_oauth_state=${NONCE}`));
    expect(res.headers.get("location")).toContain("/settings?meta=error");
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });

  it("never resolves the account from `state` when there is no session", async () => {
    m.auth.mockResolvedValue({ userId: null });
    const res = await callback(callbackRequest({ code: "c", state: NONCE }, `meta_oauth_state=${NONCE}`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });

  it("links Meta to the session user's current workspace when the state matches, and clears the state cookie", async () => {
    const res = await callback(callbackRequest({ code: "own-code", state: NONCE }, `meta_oauth_state=${NONCE}`));
    expect(res.headers.get("location")).toContain("/settings?meta=connected");
    expect(m.currentWorkspaceFor).toHaveBeenCalledWith("user_victim");
    expect(m.storeMetaConnection).toHaveBeenCalledWith(
      "ws-current",
      "user_victim",
      expect.objectContaining({ userToken: "EAAB-attacker-token", pixelId: "px_attacker", adAccountId: "act_1" }),
    );
    // The legacy row receives non-secret hints only (task 4).
    const legacy = m.upsertUserIntegration.mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(legacy)).not.toContain("EAAB-attacker-token");
    expect(Object.keys(legacy).sort()).toEqual(["meta_connected_at", "pixel_health"]);
    const cleared = setCookies(res).find((c) => c.startsWith("meta_oauth_state="));
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it("stores nothing when the user has no workspace to connect Meta to", async () => {
    m.currentWorkspaceFor.mockResolvedValue(null);
    const res = await callback(callbackRequest({ code: "own-code", state: NONCE }, `meta_oauth_state=${NONCE}`));
    expect(res.headers.get("location")).toContain("/settings?meta=no_workspace");
    expect(m.storeMetaConnection).not.toHaveBeenCalled();
    expect(m.upsertUserIntegration).not.toHaveBeenCalled();
  });

  it("handles a user denial without exchanging anything", async () => {
    const res = await callback(callbackRequest({ error: "access_denied" }, `meta_oauth_state=${NONCE}`));
    expect(res.headers.get("location")).toContain("/settings?meta=denied");
    expect(m.fetch).not.toHaveBeenCalled();
  });
});

describe("Meta OAuth connect", () => {
  it("requires a session", async () => {
    m.auth.mockResolvedValue({ userId: null });
    const res = await connect();
    expect(res.status).toBe(401);
  });

  it("sends an unguessable nonce (not the user id) and stores it in an httpOnly cookie", async () => {
    const res = await connect();
    const location = new URL(res.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(state).not.toContain("user_victim");
    const cookie = setCookies(res).find((c) => c.startsWith("meta_oauth_state="))!;
    expect(cookie).toContain(`meta_oauth_state=${state}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/meta/i);
  });
});
