import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  getUserIntegration: vi.fn(),
  updateUserIntegration: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("./db", () => ({
  getUserIntegration: db.getUserIntegration,
  updateUserIntegration: db.updateUserIntegration,
  detectDbColumns: async () => ({ hasAccessToken: true, hasRefreshToken: true, hasTokenExpiresAt: true }),
  supabaseAdmin: { rpc: db.rpc },
}));

import { getValidShopifyToken } from "./shopify-token";

const MINUTE = 60_000;
const inMinutes = (m: number) => new Date(Date.now() + m * MINUTE).toISOString();
const rowExpiring = (minutes: number, extra: Record<string, unknown> = {}) => ({
  shop_domain: "s.myshopify.com",
  access_token: "old-access",
  refresh_token: "old-refresh",
  token_expires_at: inMinutes(minutes),
  ...extra,
});
const rotated = () =>
  new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fetchMock = vi.fn();
let lockHeld = false;

beforeEach(() => {
  lockHeld = false;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  db.row = rowExpiring(2);
  db.getUserIntegration.mockReset().mockImplementation(async () => db.row);
  db.updateUserIntegration.mockReset().mockImplementation(async (_user: string, data: Record<string, unknown>) => {
    db.row = { ...db.row, ...data };
  });
  db.rpc.mockReset().mockImplementation(async (name: string) => {
    if (name === "acquire_refresh_lock") {
      if (lockHeld) return { data: false, error: null };
      lockHeld = true;
      return { data: true, error: null };
    }
    lockHeld = false;
    return { data: null, error: null };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refresh window (ING-04)", () => {
  it("does not rotate a token with 30 of its 60 minutes left", async () => {
    db.row = rowExpiring(30);
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ status: "ok", accessToken: "old-access" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rotates a token within 5 minutes of expiry and stores the new pair", async () => {
    fetchMock.mockResolvedValueOnce(rotated());
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ status: "ok", accessToken: "new-access" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.row).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh" });
  });
});

describe("single-use refresh tokens", () => {
  it("never retries the refresh POST, even on a 5xx", async () => {
    fetchMock.mockResolvedValue(new Response("upstream error", { status: 503 }));
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ status: "ok", accessToken: "old-access" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("presents the refresh token re-read under the lock, not the one read before it", async () => {
    let reads = 0;
    db.getUserIntegration.mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? rowExpiring(2, { refresh_token: "stale" }) : rowExpiring(2, { refresh_token: "current" });
    });
    fetchMock.mockResolvedValueOnce(rotated());
    await getValidShopifyToken("u1");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).refresh_token).toBe("current");
  });

  it("skips the network call when another instance already rotated before the lock", async () => {
    let reads = 0;
    db.getUserIntegration.mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? rowExpiring(2) : rowExpiring(60, { access_token: "already-rotated" });
    });
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ accessToken: "already-rotated" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("collapses concurrent calls in one process into a single rotation", async () => {
    fetchMock.mockResolvedValueOnce(rotated());
    const results = await Promise.all(Array.from({ length: 5 }, () => getValidShopifyToken("u1")));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === "ok" && r.accessToken === "new-access")).toBe(true);
  });

  it("retries storing a rotated token, because the old refresh token is already gone", async () => {
    fetchMock.mockResolvedValueOnce(rotated());
    db.updateUserIntegration.mockRejectedValueOnce(new Error("db blip"));
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ accessToken: "new-access" });
    expect(db.updateUserIntegration).toHaveBeenCalledTimes(2);
  });
});

describe("cross-instance races never force a reconnect", () => {
  it("lock loser keeps using a token that has not expired yet", async () => {
    lockHeld = true;
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ status: "ok", accessToken: "old-access" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lock loser waits for the winner when the token has already expired", async () => {
    lockHeld = true;
    db.row = rowExpiring(-1);
    setTimeout(() => {
      db.row = rowExpiring(60, { access_token: "winner-access" });
    }, 100);
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ status: "ok", accessToken: "winner-access" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a consumed-token error as a lost race when a newer token is stored", async () => {
    fetchMock.mockImplementationOnce(async () => {
      db.row = rowExpiring(60, { access_token: "winner-access", refresh_token: "winner-refresh" });
      return new Response('{"error":"invalid_request"}', { status: 401, headers: { "content-type": "application/json" } });
    });
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ status: "ok", accessToken: "winner-access" });
  });
});

describe("failure outcomes", () => {
  it("asks for a reconnect only when the refresh token is really dead", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"invalid_grant"}', { status: 401, headers: { "content-type": "application/json" } }),
    );
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ status: "reauth_required" });
  });

  it("does not hand back an expired token after a transient failure", async () => {
    db.row = rowExpiring(-1);
    fetchMock.mockResolvedValueOnce(new Response("upstream error", { status: 502 }));
    await expect(getValidShopifyToken("u1")).resolves.toMatchObject({ status: "temporarily_unavailable" });
  });

  it("never logs token values or Shopify response bodies", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response('{"refresh_token":"leak-me"}', { status: 500 }));
    await getValidShopifyToken("u1");
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/leak-me|old-refresh|old-access/);
  });
});
