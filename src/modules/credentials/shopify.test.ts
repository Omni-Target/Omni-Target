import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateCredentialKey, resetCredentialKeyringForTests } from "@/platform/credentials/crypto";

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/platform/supabase", () => ({ supabaseAdmin: { rpc: db.rpc } }));

import { getShopifyAccessForShop, getShopifyAccessForWorkspace, sealShopCredential } from "./shopify";

const KEY_V1 = generateCredentialKey();
const KEY_V2 = generateCredentialKey();
const MINUTE = 60_000;

/** What shop_credential_for_* returns for a sealed credential. */
function row(sealed: ReturnType<typeof sealShopCredential>, overrides: Record<string, unknown> = {}) {
  return {
    outcome: "ok",
    shop_id: "shop-uuid",
    shopify_shop_id: "548380009",
    shop_domain: "s.myshopify.com",
    workspace_id: "ws-1",
    version: 3,
    key_version: sealed.key_version,
    status: "active",
    access: sealed.access,
    refresh: sealed.refresh,
    access_expires_at: sealed.access_expires_at,
    ...overrides,
  };
}

let logs: string[] = [];
beforeEach(() => {
  vi.stubEnv("APP_ENCRYPTION_KEY", KEY_V1);
  vi.stubEnv("APP_ENCRYPTION_KEY_VERSION", "1");
  vi.stubEnv("APP_ENCRYPTION_PREVIOUS_KEYS", "");
  vi.stubEnv("SHOPIFY_TOKEN_REFRESH_DISABLED", "");
  resetCredentialKeyringForTests();
  db.rpc.mockReset();
  logs = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCredentialKeyringForTests();
});

describe("sealing", () => {
  it("never puts a token in what is sent to the database", () => {
    const sealed = sealShopCredential(548380009, { accessToken: "shpat_live_value", refreshToken: "shprt_live_value", expiresIn: 3600, scope: "read_products" });
    expect(JSON.stringify(sealed)).not.toMatch(/shpat_live_value|shprt_live_value/);
    expect(sealed.key_version).toBe(1);
    expect(sealed.access_expires_at).not.toBeNull();
  });
});

describe("issuing a token", () => {
  it("decrypts the workspace's own credential", async () => {
    const sealed = sealShopCredential(548380009, { accessToken: "shpat_a", refreshToken: "shprt_a", expiresIn: 3600, scope: null });
    db.rpc.mockResolvedValue({ data: row(sealed), error: null });
    expect(await getShopifyAccessForWorkspace("ws-1", "user_a")).toEqual({ status: "ok", accessToken: "shpat_a", shopUrl: "s.myshopify.com" });
    expect(db.rpc).toHaveBeenCalledWith("shop_credential_for_workspace", { p_workspace: "ws-1", p_actor: "user_a" });
  });

  it("issues nothing for an inactive workspace, another user's workspace or an unknown shop", async () => {
    for (const outcome of ["workspace_inactive", "access_denied", "not_connected", "not_modelled"]) {
      db.rpc.mockResolvedValue({ data: { outcome }, error: null });
      expect(await getShopifyAccessForShop("s.myshopify.com"), outcome).toEqual({ status: "not_connected" });
    }
  });

  it("refuses a ciphertext that was moved to another shop", async () => {
    const otherShops = sealShopCredential(111111111, { accessToken: "shpat_other", refreshToken: null, expiresIn: 3600, scope: null });
    db.rpc.mockResolvedValue({ data: row(otherShops), error: null });
    await expect(getShopifyAccessForWorkspace("ws-1", "user_a")).rejects.toThrow("Credential could not be decrypted");
  });
});

describe("refresh through the credential service", () => {
  it("stores only sealed values and logs no token", async () => {
    const sealed = sealShopCredential(548380009, { accessToken: "shpat_old", refreshToken: "shprt_old", expiresIn: 60, scope: null });
    db.rpc.mockImplementation(async (fn: string) => {
      if (fn === "acquire_shop_lease") return { data: "holder-1", error: null };
      if (fn === "store_refreshed_shop_credential") return { data: { outcome: "stored" }, error: null };
      if (fn === "release_shop_lease") return { data: true, error: null };
      return { data: row(sealed), error: null };
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "shpat_new", refresh_token: "shprt_new", expires_in: 3600 })));

    expect(await getShopifyAccessForWorkspace("ws-1", "user_a")).toEqual({ status: "ok", accessToken: "shpat_new", shopUrl: "s.myshopify.com" });
    const store = db.rpc.mock.calls.find(([fn]) => fn === "store_refreshed_shop_credential")!;
    expect(store[1]).toMatchObject({ p_shop: "shop-uuid", p_holder: "holder-1", p_expected_version: 3 });
    expect(JSON.stringify(store[1])).not.toMatch(/shpat_|shprt_/);
    expect(db.rpc).toHaveBeenCalledWith("acquire_shop_lease", expect.objectContaining({ p_key: "refresh:shop-uuid", p_purpose: "refresh" }));
    expect(logs.join("\n")).not.toMatch(/shpat_|shprt_/);
  });

  it("keeps the credential and records only a classification when Shopify rejects the refresh", async () => {
    const sealed = sealShopCredential(548380009, { accessToken: "shpat_old", refreshToken: "shprt_old", expiresIn: 60, scope: null });
    db.rpc.mockImplementation(async (fn: string) => {
      if (fn === "acquire_shop_lease") return { data: "holder-1", error: null };
      if (fn === "record_shop_refresh_failure" || fn === "release_shop_lease") return { data: true, error: null };
      return { data: row(sealed), error: null };
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"invalid_request","detail":"shprt_old"}', { status: 401 })));

    expect((await getShopifyAccessForWorkspace("ws-1", "user_a")).status).toBe("reauth_required");
    expect(db.rpc).toHaveBeenCalledWith("record_shop_refresh_failure", { p_shop: "shop-uuid", p_expected_version: 3, p_dead: true, p_error: "refresh_rejected_401" });
    expect(db.rpc.mock.calls.some(([fn]) => /delete|clear/.test(fn))).toBe(false);
    expect(logs.join("\n")).not.toMatch(/shpat_|shprt_/);
  });
});

describe("key rotation", () => {
  it("re-encrypts a credential sealed under an older key when it is next read", async () => {
    const sealed = sealShopCredential(548380009, { accessToken: "shpat_a", refreshToken: "shprt_a", expiresIn: 3600, scope: null });
    vi.stubEnv("APP_ENCRYPTION_KEY", KEY_V2);
    vi.stubEnv("APP_ENCRYPTION_KEY_VERSION", "2");
    vi.stubEnv("APP_ENCRYPTION_PREVIOUS_KEYS", `1:${KEY_V1}`);
    resetCredentialKeyringForTests();
    db.rpc.mockImplementation(async (fn: string) => (fn === "reseal_shop_credential" ? { data: true, error: null } : { data: row(sealed), error: null }));

    expect(await getShopifyAccessForWorkspace("ws-1", "user_a")).toMatchObject({ status: "ok", accessToken: "shpat_a" });
    const reseal = db.rpc.mock.calls.find(([fn]) => fn === "reseal_shop_credential")!;
    expect(reseal[1]).toMatchObject({ p_shop: "shop-uuid", p_expected_version: 3, p_credential: expect.objectContaining({ key_version: 2 }) });
    expect(JSON.stringify(reseal[1])).not.toMatch(/shpat_|shprt_/);
  });

  it("is not needed for a credential already under the current key", async () => {
    const sealed = sealShopCredential(548380009, { accessToken: "shpat_a", refreshToken: null, expiresIn: 30 * MINUTE / 1000, scope: null });
    db.rpc.mockResolvedValue({ data: row(sealed), error: null });
    await getShopifyAccessForWorkspace("ws-1", "user_a");
    expect(db.rpc.mock.calls.some(([fn]) => fn === "reseal_shop_credential")).toBe(false);
  });
});
