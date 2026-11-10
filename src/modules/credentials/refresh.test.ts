import { describe, expect, it, vi } from "vitest";
import { accessWithRefresh, classifyRefreshFailure, type LoadedCredential, type RefreshPorts, type RefreshResponse } from "./refresh";

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

/** An in-memory stand-in for the database: one lease per shop and a versioned credential. */
function harness(initial: Partial<LoadedCredential> = {}, refresh?: RefreshPorts["refresh"]) {
  const state = {
    credential: {
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
      version: 1,
      status: "active",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accessExpiresAt: NOW + 2 * MINUTE,
      ...initial,
    } as LoadedCredential | null,
    holder: null as string | null,
    refreshDisabled: false,
  };
  const ok: RefreshResponse = { ok: true, accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, refreshExpiresIn: null, scope: null };
  const ports = {
    acquire: vi.fn(async () => (state.holder ? null : (state.holder = "holder-1"))),
    release: vi.fn(async (_shop: string, holder: string) => {
      if (state.holder === holder) state.holder = null;
    }),
    reload: vi.fn(async () => (state.credential ? { ...state.credential } : null)),
    refresh: vi.fn(refresh ?? (async () => ok)),
    store: vi.fn(async (_shop: string, holder: string, version: number, response: Extract<RefreshResponse, { ok: true }>) => {
      if (holder !== state.holder) return "lease_lost" as const;
      if (!state.credential || version !== state.credential.version) return "stale" as const;
      state.credential = { ...state.credential, version: version + 1, accessToken: response.accessToken, refreshToken: response.refreshToken, accessExpiresAt: NOW + 60 * MINUTE };
      return "stored" as const;
    }),
    recordFailure: vi.fn(async (_shop: string, version: number, dead: boolean) => {
      if (state.credential && version === state.credential.version && dead) state.credential = { ...state.credential, status: "refresh_failed" };
    }),
    refreshDisabled: () => state.refreshDisabled,
    sleep: vi.fn(async () => undefined),
    now: () => NOW,
  } satisfies RefreshPorts;
  return { state, ports };
}

describe("refresh window (ING-04)", () => {
  it("does not rotate a token with 30 of its 60 minutes left", async () => {
    const { ports } = harness({ accessExpiresAt: NOW + 30 * MINUTE });
    expect(await accessWithRefresh((await ports.reload())!, ports)).toEqual({ status: "ok", accessToken: "old-access", shopUrl: "s.myshopify.com" });
    expect(ports.refresh).not.toHaveBeenCalled();
    expect(ports.acquire).not.toHaveBeenCalled();
  });

  it("rotates within 5 minutes of expiry, under the lease, and stores the new pair over the version it read", async () => {
    const { state, ports } = harness();
    const result = await accessWithRefresh((await ports.reload())!, ports);
    expect(result).toEqual({ status: "ok", accessToken: "new-access", shopUrl: "s.myshopify.com" });
    expect(ports.refresh).toHaveBeenCalledWith("s.myshopify.com", "old-refresh");
    expect(ports.store).toHaveBeenCalledWith("shop-1", "holder-1", 1, expect.objectContaining({ accessToken: "new-access" }));
    expect(state.credential).toMatchObject({ version: 2, refreshToken: "new-refresh" });
    expect(state.holder).toBeNull();
  });
});

describe("one refresh per shop", () => {
  it("lets only the lease holder call Shopify; the others wait and use what it stored", async () => {
    const { state, ports } = harness();
    let releaseShopify!: () => void;
    const shopifyAnswer = new Promise<void>((resolve) => (releaseShopify = resolve));
    ports.refresh.mockImplementationOnce(async () => {
      await shopifyAnswer;
      return { ok: true, accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, refreshExpiresIn: null, scope: null };
    });
    const initial = (await ports.reload())!;
    const first = accessWithRefresh(initial, ports);
    await vi.waitFor(() => expect(ports.refresh).toHaveBeenCalledTimes(1));
    const others = Array.from({ length: 4 }, () => accessWithRefresh(initial, ports, { attempts: 50, pollMs: 1 }));
    releaseShopify();
    const results = await Promise.all([first, ...others]);
    expect(ports.refresh).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === "ok" && r.accessToken === "new-access")).toBe(true);
    expect(state.credential?.version).toBe(2);
  });

  it("skips Shopify when another worker refreshed between the read and the lease", async () => {
    const { state, ports } = harness();
    const stale = (await ports.reload())!;
    state.credential = { ...state.credential!, version: 2, accessToken: "fresher", accessExpiresAt: NOW + 59 * MINUTE };
    expect(await accessWithRefresh(stale, ports)).toEqual({ status: "ok", accessToken: "fresher", shopUrl: "s.myshopify.com" });
    expect(ports.refresh).not.toHaveBeenCalled();
  });

  it("never overwrites a newer credential: a stale write is refused and the newer one is used", async () => {
    const { state, ports } = harness(undefined, async () => {
      // A reconnection stores a newer credential while this refresh is in flight.
      state.credential = { ...state.credential!, version: 7, accessToken: "from-reconnect", accessExpiresAt: NOW + 60 * MINUTE };
      return { ok: true, accessToken: "stale-refresh-result", refreshToken: "x", expiresIn: 3600, refreshExpiresIn: null, scope: null };
    });
    const result = await accessWithRefresh((await ports.reload())!, ports);
    expect(result).toEqual({ status: "ok", accessToken: "from-reconnect", shopUrl: "s.myshopify.com" });
    expect(state.credential).toMatchObject({ version: 7, accessToken: "from-reconnect" });
  });

  it("keeps the current refresh token if Shopify answers without a new one", async () => {
    const { state, ports } = harness(undefined, async () => ({ ok: true, accessToken: "new-access", refreshToken: null, expiresIn: 3600, refreshExpiresIn: null, scope: null }));
    await accessWithRefresh((await ports.reload())!, ports);
    expect(state.credential?.refreshToken).toBe("old-refresh");
  });
});

describe("failures never destroy a healthy credential", () => {
  it("asks for a reconnect only when Shopify rejects the refresh token, and keeps the credential", async () => {
    const { state, ports } = harness(undefined, async () => ({ ok: false, dead: true, error: "refresh_rejected_401" }));
    expect(await accessWithRefresh((await ports.reload())!, ports)).toEqual({ status: "reauth_required", shopUrl: "s.myshopify.com" });
    expect(ports.recordFailure).toHaveBeenCalledWith("shop-1", 1, true, "refresh_rejected_401");
    expect(state.credential).toMatchObject({ status: "refresh_failed", accessToken: "old-access" });
  });

  it("keeps using a still-valid token after a transient failure, and never hands back an expired one", async () => {
    const transient = async () => ({ ok: false as const, dead: false, error: "refresh_failed_503" });
    const valid = harness(undefined, transient);
    expect(await accessWithRefresh((await valid.ports.reload())!, valid.ports)).toEqual({ status: "ok", accessToken: "old-access", shopUrl: "s.myshopify.com" });
    expect(valid.state.credential?.status).toBe("active");

    const expired = harness({ accessExpiresAt: NOW - MINUTE }, transient);
    expect(await accessWithRefresh((await expired.ports.reload())!, expired.ports)).toEqual({ status: "temporarily_unavailable", shopUrl: "s.myshopify.com" });
  });

  it("does not call Shopify again for a credential already marked for reconnection", async () => {
    const { ports } = harness({ status: "refresh_failed" });
    expect((await accessWithRefresh((await ports.reload())!, ports)).status).toBe("reauth_required");
    expect(ports.refresh).not.toHaveBeenCalled();
  });

  it("reports not connected when the workspace stops being issuable mid-refresh", async () => {
    const { state, ports } = harness();
    const initial = { ...state.credential! };
    ports.acquire.mockImplementationOnce(async () => {
      state.credential = null; // an uninstall cleared it
      return (state.holder = "holder-1");
    });
    expect(await accessWithRefresh(initial, ports)).toEqual({ status: "not_connected" });
    expect(ports.refresh).not.toHaveBeenCalled();
  });

  it("never calls Shopify when refresh is disabled for the environment", async () => {
    const { state, ports } = harness();
    state.refreshDisabled = true;
    expect(await accessWithRefresh((await ports.reload())!, ports)).toEqual({ status: "ok", accessToken: "old-access", shopUrl: "s.myshopify.com" });
    expect(ports.refresh).not.toHaveBeenCalled();
  });
});

describe("classifyRefreshFailure", () => {
  it("treats only Shopify's rejection of the refresh token as dead, and keeps no response body", () => {
    expect(classifyRefreshFailure(401, '{"error":"invalid_request"}')).toEqual({ dead: true, error: "refresh_rejected_401" });
    expect(classifyRefreshFailure(400, '{"error":"invalid_grant"}')).toEqual({ dead: true, error: "refresh_rejected_400" });
    expect(classifyRefreshFailure(503, "upstream shpat_secret")).toEqual({ dead: false, error: "refresh_failed_503" });
    expect(classifyRefreshFailure(401, "rate limited")).toEqual({ dead: false, error: "refresh_failed_401" });
  });
});
