/**
 * Real Postgres tests for encrypted credentials (Phase 1, task 4). The
 * application's own sealing and refresh orchestration run against migration
 * 0020's functions, called as service_role. Shopify's refresh endpoint is
 * simulated with its documented rotation: each refresh token works once.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  CredentialDecryptError,
  credentialAad,
  credentialKeyring,
  generateCredentialKey,
  open,
  resetCredentialKeyringForTests,
  seal,
} from "@/platform/credentials/crypto";
import { sealShopCredential } from "./shopify";
import { accessWithRefresh, type LoadedCredential, type RefreshPorts, type RefreshResponse } from "./refresh";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const KEY_V1 = generateCredentialKey();
beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = KEY_V1;
  process.env.APP_ENCRYPTION_KEY_VERSION = "1";
  delete process.env.APP_ENCRYPTION_PREVIOUS_KEYS;
  resetCredentialKeyringForTests();
});

const pool = new pg.Pool({ connectionString: url, max: 30 });
afterAll(() => pool.end());

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
async function svc<T>(fn: string, ...args: unknown[]): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args);
    await client.query("commit");
    return rows[0].result as T;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const user = () => `user_test_${tag()}`;
const domain = () => `t-${tag()}.myshopify.com`;
const shopId = () => Math.floor(Math.random() * 9e12) + 1e12;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const expireLease = (key: string) =>
  q("update public.shop_leases set acquired_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where lease_key = $1", [key]);

interface Payload {
  outcome: string;
  shop_id: string;
  shopify_shop_id: string;
  version: number;
  key_version: number;
  status: "active" | "refresh_failed";
  access: { ciphertext: string; nonce: string; tag: string };
  refresh: { ciphertext: string; nonce: string; tag: string } | null;
  access_expires_at: string | null;
  shop_domain: string;
}

/** The app's installation commit: binding and encrypted credential in one call, under the lease. */
async function connect(actor: string, shop = domain(), id = shopId(), expiresIn = 3600, transfer: string | null = null) {
  const holder = await svc<string>("acquire_shop_lease", `install:${shop}`, "install", actor, 60);
  const access = `shpat_${tag()}`;
  const refresh = `shprt_${tag()}`;
  const result = await svc<{ outcome: string; workspace_id: string }>(
    "commit_shop_install_under_lease", shop, holder, id, shop, actor, null, "Shop", transfer,
    sealShopCredential(id, { accessToken: access, refreshToken: refresh, expiresIn, scope: "read_products" }),
  );
  await svc("release_shop_lease", `install:${shop}`, holder);
  return { shop, id, actor, access, refresh, workspace: result.workspace_id, outcome: result.outcome };
}

function opened(p: Payload) {
  const sealedOf = (part: Payload["access"]) => ({ ...part, keyVersion: p.key_version });
  return {
    access: open(sealedOf(p.access), credentialAad.shopify(p.shopify_shop_id, "access")),
    refresh: p.refresh ? open(sealedOf(p.refresh), credentialAad.shopify(p.shopify_shop_id, "refresh")) : null,
  };
}
const forWorkspace = (ws: string, actor: string) => svc<Payload>("shop_credential_for_workspace", ws, actor);
const forShop = (shop: string) => svc<Payload>("shop_credential_for_shop", shop);

describe("one independent Shopify credential per shop", () => {
  it("keeps two shops of the same user connected with their own credentials", async () => {
    const actor = user();
    const a = await connect(actor);
    const b = await connect(actor);
    expect(a.workspace).not.toBe(b.workspace);
    expect(opened(await forWorkspace(a.workspace, actor)).access).toBe(a.access);
    expect(opened(await forWorkspace(b.workspace, actor)).access).toBe(b.access);
    expect((await svc<Array<{ status: string }>>("list_workspaces", actor)).map((w) => w.status)).toEqual(["active", "active"]);
  });

  it("refreshing one shop leaves the other untouched", async () => {
    const actor = user();
    const a = await connect(actor);
    const b = await connect(actor);
    const beforeA = await forWorkspace(a.workspace, actor);
    const pb = await forWorkspace(b.workspace, actor);
    const holder = await svc<string>("acquire_shop_lease", `refresh:${pb.shop_id}`, "refresh", "test", 30);
    const stored = await svc<{ outcome: string }>("store_refreshed_shop_credential", pb.shop_id, holder, pb.version,
      sealShopCredential(b.id, { accessToken: "shpat_b_rotated", refreshToken: "shprt_b_rotated", expiresIn: 3600, scope: null }));
    expect(stored.outcome).toBe("stored");
    expect(opened(await forWorkspace(b.workspace, actor)).access).toBe("shpat_b_rotated");
    const afterA = await forWorkspace(a.workspace, actor);
    expect(afterA.version).toBe(beforeA.version);
    expect(opened(afterA).access).toBe(a.access);
  });

  it("restores a reconnected shop's credential to that shop only", async () => {
    const actor = user();
    const a = await connect(actor);
    const b = await connect(actor);
    await svc("disconnect_workspace", a.workspace, actor);
    expect((await forWorkspace(a.workspace, actor)).outcome).toBe("workspace_inactive");
    expect(await q("select 1 from public.shop_credentials where workspace_id = $1", [a.workspace])).toEqual([]);
    const again = await connect(actor, a.shop, a.id);
    expect(again.outcome).toBe("reconnected");
    expect(opened(await forWorkspace(a.workspace, actor)).access).toBe(again.access);
    expect(opened(await forWorkspace(b.workspace, actor)).access).toBe(b.access);
  });

  it("never gives one account another workspace's credential, and refuses a ciphertext moved between shops", async () => {
    const a = await connect(user());
    const b = await connect(user());
    expect((await forWorkspace(a.workspace, b.actor)).outcome).toBe("access_denied");
    // Copy shop A's ciphertext onto shop B's row, as a database-level attacker could.
    await q(`update public.shop_credentials t set access_ciphertext = s.access_ciphertext, access_nonce = s.access_nonce, access_tag = s.access_tag
               from public.shop_credentials s where s.workspace_id = $1 and t.workspace_id = $2`, [a.workspace, b.workspace]);
    const moved = await forWorkspace(b.workspace, b.actor);
    expect(() => opened(moved)).toThrow(CredentialDecryptError);
  });
});

describe("credentials follow the workspace lifecycle", () => {
  it("issues nothing to an uninstalled workspace and clears its credential", async () => {
    const s = await connect(user());
    await svc("begin_uninstall", s.id, s.shop, `uninstall-${tag()}`, new Date(Date.now() + 1000).toISOString());
    expect((await forWorkspace(s.workspace, s.actor)).outcome).toBe("workspace_inactive");
    expect((await forShop(s.shop)).outcome).toBe("workspace_inactive");
    expect(await q("select 1 from public.shop_credentials where workspace_id = $1", [s.workspace])).toEqual([]);
    expect(await q("select event from public.workspace_events where workspace_id = $1 and event = 'credential_cleared'", [s.workspace])).toHaveLength(1);
  });

  it("cannot be bypassed by a refresh: a pending deletion refuses the store", async () => {
    const s = await connect(user());
    const p = await forWorkspace(s.workspace, s.actor);
    const holder = await svc<string>("acquire_shop_lease", `refresh:${p.shop_id}`, "refresh", "test", 30);
    await svc("begin_uninstall", s.id, s.shop, `uninstall-${tag()}`, new Date(Date.now() + 1000).toISOString());
    const stored = await svc<{ outcome: string }>("store_refreshed_shop_credential", p.shop_id, holder, p.version,
      sealShopCredential(s.id, { accessToken: "shpat_late", refreshToken: "shprt_late", expiresIn: 3600, scope: null }));
    expect(stored.outcome).toBe("stale");
    expect(await q("select 1 from public.shop_credentials where shop_id = $1", [p.shop_id])).toEqual([]);
  });

  it("redacting one shop never clears another workspace's credentials", async () => {
    const actor = user();
    const a = await connect(actor);
    const b = await connect(actor);
    const started = await svc<{ deletion_id: string }>("record_shop_redact", a.id, a.shop, `redact-${tag()}`, new Date().toISOString());
    expect((await svc<{ outcome: string }>("process_workspace_deletion", started.deletion_id)).outcome).toBe("completed");
    expect(await q("select 1 from public.shop_credentials where workspace_id = $1", [a.workspace])).toEqual([]);
    expect(opened(await forWorkspace(b.workspace, actor)).access).toBe(b.access);
  });

  it("hands the shop's credential to the new owner on transfer; the old workspace's later deletion cannot touch it", async () => {
    const owner = await connect(user());
    const requester = user();
    const { transfer_id: transfer } = await svc<{ transfer_id: string }>("request_ownership_transfer", owner.shop, requester, null, "sale");
    await svc("verify_ownership_transfer", transfer, requester, owner.shop);
    await svc("approve_ownership_transfer", transfer, owner.actor);
    const completed = await connect(requester, owner.shop, owner.id, 3600, transfer);
    expect(completed.outcome).toBe("completed");
    expect(opened(await forWorkspace(completed.workspace, requester)).access).toBe(completed.access);
    expect((await forWorkspace(owner.workspace, owner.actor)).outcome).toBe("workspace_inactive");
    await q("update public.workspaces set status = 'deleted', status_changed_at = now(), deleted_at = now() where id = $1", [owner.workspace]);
    expect(opened(await forWorkspace(completed.workspace, requester)).access).toBe(completed.access);
  });
});

describe("Meta credentials belong to one workspace", () => {
  const sealMeta = (ws: string, token: string) => {
    const s = seal(token, credentialAad.meta(ws, "user"));
    return { key_version: s.keyVersion, ciphertext: s.ciphertext, nonce: s.nonce, tag: s.tag, subject_id: null, expires_at: null };
  };
  type MetaRow = { outcome: string; user: { key_version: number; ciphertext: string; nonce: string; tag: string } };

  it("keeps each workspace's Meta connection to itself, even for the same owner", async () => {
    const actor = user();
    const a = await connect(actor);
    const b = await connect(actor);
    await svc("store_meta_connection", a.workspace, actor, sealMeta(a.workspace, "EAAG_workspace_a"), null,
      { ad_accounts: [{ id: "act_1" }], pages: [{ id: "p1", name: "Page" }], ad_account_id: "act_1", pixel_id: "px_1" });
    const accessA = await svc<MetaRow>("meta_access_for_workspace", a.workspace, actor);
    const sealedA = { ...accessA.user, keyVersion: accessA.user.key_version };
    expect(open(sealedA, credentialAad.meta(a.workspace, "user"))).toBe("EAAG_workspace_a");
    expect((await svc<{ outcome: string }>("meta_access_for_workspace", b.workspace, actor)).outcome).toBe("not_connected");
    expect((await svc<{ outcome: string }>("meta_access_for_workspace", a.workspace, user())).outcome).toBe("access_denied");
    // A ciphertext copied to another workspace fails authentication.
    expect(() => open(sealedA, credentialAad.meta(b.workspace, "user"))).toThrow(CredentialDecryptError);
  });

  it("refuses token-bearing listings and stores nothing for another user's workspace", async () => {
    const s = await connect(user());
    await expect(svc("store_meta_connection", s.workspace, s.actor, sealMeta(s.workspace, "EAAG_x"), null,
      { pages: [{ id: "p1", access_token: "EAAG_page" }] })).rejects.toThrow("workspace_meta_connections_no_tokens");
    await expect(svc("store_meta_connection", s.workspace, user(), sealMeta(s.workspace, "EAAG_x"), null, {})).rejects.toThrow("workspace_access_denied");
  });

  it("deletes a workspace's Meta credentials with the workspace, and only that workspace's", async () => {
    const actor = user();
    const a = await connect(actor);
    const b = await connect(actor);
    for (const ws of [a.workspace, b.workspace]) await svc("store_meta_connection", ws, actor, sealMeta(ws, `EAAG_${ws}`), null, {});
    const started = await svc<{ deletion_id: string }>("record_shop_redact", a.id, a.shop, `redact-${tag()}`, new Date().toISOString());
    await svc("process_workspace_deletion", started.deletion_id);
    expect(await q("select workspace_id from public.workspace_meta_credentials where workspace_id = any($1)", [[a.workspace, b.workspace]]))
      .toEqual([{ workspace_id: b.workspace }]);
  });
});

/** Shopify's refresh endpoint: each refresh token works once, then is retired. */
class SimulatedRefresh {
  private live = new Set<string>();
  calls = 0;
  constructor(initial: string) {
    this.live.add(initial);
  }
  async refresh(_shop: string, token: string, delayMs = 30): Promise<RefreshResponse> {
    this.calls++;
    await sleep(delayMs);
    if (!this.live.delete(token)) return { ok: false, dead: true, error: "refresh_rejected_401" };
    const next = `shprt_${tag()}`;
    this.live.add(next);
    return { ok: true, accessToken: `shpat_${tag()}`, refreshToken: next, expiresIn: 3600, refreshExpiresIn: null, scope: null };
  }
}

function refreshPorts(ws: string, actor: string, id: number, shopify: SimulatedRefresh, overrides: Partial<RefreshPorts> = {}): RefreshPorts {
  const load = async (): Promise<LoadedCredential | null> => {
    const p = await forWorkspace(ws, actor);
    if (p.outcome !== "ok") return null;
    const { access, refresh } = opened(p);
    return { shopId: p.shop_id, shopDomain: p.shop_domain, version: Number(p.version), status: p.status, accessToken: access, refreshToken: refresh,
      accessExpiresAt: p.access_expires_at ? Date.parse(p.access_expires_at) : null };
  };
  return {
    acquire: (shop) => svc<string | null>("acquire_shop_lease", `refresh:${shop}`, "refresh", "test", 30),
    release: async (shop, holder) => {
      await svc("release_shop_lease", `refresh:${shop}`, holder);
    },
    reload: load,
    refresh: (shop, token) => shopify.refresh(shop, token),
    store: async (shop, holder, version, response) =>
      (await svc<{ outcome: "stored" | "stale" | "lease_lost" }>("store_refreshed_shop_credential", shop, holder, version, sealShopCredential(id, response))).outcome,
    recordFailure: async (shop, version, dead, error) => {
      await svc("record_shop_refresh_failure", shop, version, dead, error);
    },
    refreshDisabled: () => false,
    sleep,
    now: () => Date.now(),
    ...overrides,
  };
}

describe("refresh under the shop's lease", () => {
  it("lets one of many simultaneous workers rotate the token; all end with the same new token", async () => {
    const s = await connect(user(), domain(), shopId(), 60); // expires within the refresh margin
    const shopify = new SimulatedRefresh(s.refresh);
    const ports = refreshPorts(s.workspace, s.actor, s.id, shopify);
    const initial = (await ports.reload())!;
    const results = await Promise.all(Array.from({ length: 8 }, () => accessWithRefresh(initial, ports, { attempts: 100, pollMs: 15 })));
    expect(shopify.calls).toBe(1);
    const tokens = new Set(results.map((r) => (r.status === "ok" ? r.accessToken : r.status)));
    expect(tokens.size).toBe(1);
    const stored = await forWorkspace(s.workspace, s.actor);
    expect(stored.version).toBe(initial.version + 1);
    expect(opened(stored).access).toBe([...tokens][0]);
  });

  it("never lets a stale worker overwrite the token stored by the worker that took over", async () => {
    const s = await connect(user(), domain(), shopId(), 60);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const slowShopify = new SimulatedRefresh(s.refresh);
    const slowPorts = refreshPorts(s.workspace, s.actor, s.id, slowShopify, {
      refresh: async (shop, token) => {
        const answer = await slowShopify.refresh(shop, token, 0);
        started();
        await paused;
        return answer;
      },
    });
    const initial = (await slowPorts.reload())!;
    const slow = accessWithRefresh(initial, slowPorts);
    await inFlight;

    // The slow worker's lease expires; a second worker takes over, refreshes and stores first.
    await expireLease(`refresh:${initial.shopId}`);
    const fresh = await accessWithRefresh((await slowPorts.reload())!, refreshPorts(s.workspace, s.actor, s.id, new SimulatedRefresh(s.refresh)));
    expect(fresh.status).toBe("ok");
    const afterTakeover = await forWorkspace(s.workspace, s.actor);
    expect(afterTakeover.version).toBe(initial.version + 1);

    resume();
    const slowResult = await slow;
    const final = await forWorkspace(s.workspace, s.actor);
    expect(final.version).toBe(afterTakeover.version);
    expect(opened(final).access).toBe(fresh.status === "ok" ? fresh.accessToken : "");
    expect(slowResult).toEqual({ status: "ok", accessToken: opened(final).access, shopUrl: s.shop });
  });

  it("keeps the credential when Shopify rejects the refresh token, marking it for reconnection", async () => {
    const s = await connect(user(), domain(), shopId(), 60);
    const ports = refreshPorts(s.workspace, s.actor, s.id, new SimulatedRefresh("not-the-stored-token"));
    expect((await accessWithRefresh((await ports.reload())!, ports)).status).toBe("reauth_required");
    const row = (await q<{ status: string; last_error: string }>("select status, last_error from public.shop_credentials where workspace_id = $1", [s.workspace]))[0];
    expect(row).toEqual({ status: "refresh_failed", last_error: "refresh_rejected_401" });
  });

  it("recovers a refresh lease left by a crashed worker", async () => {
    const s = await connect(user(), domain(), shopId(), 60);
    const p = await forWorkspace(s.workspace, s.actor);
    await svc("acquire_shop_lease", `refresh:${p.shop_id}`, "refresh", "crashed-worker", 30);
    const shopify = new SimulatedRefresh(s.refresh);
    const ports = refreshPorts(s.workspace, s.actor, s.id, shopify);
    // While the lease is live, the still-valid token is used and Shopify is not called.
    expect((await accessWithRefresh((await ports.reload())!, ports, { attempts: 3, pollMs: 10 })).status).toBe("ok");
    expect(shopify.calls).toBe(0);
    await expireLease(`refresh:${p.shop_id}`);
    expect((await accessWithRefresh((await ports.reload())!, ports)).status).toBe("ok");
    expect(shopify.calls).toBe(1);
  });
});

describe("at rest and across key versions", () => {
  it("stores ciphertext only, with no token bytes in any credential column", async () => {
    const s = await connect(user());
    const [row] = await q<{ dump: string }>("select row_to_json(c)::text as dump from public.shop_credentials c where workspace_id = $1", [s.workspace]);
    expect(row.dump).not.toContain(s.access);
    expect(row.dump).not.toContain(s.refresh);
    expect(row.dump).not.toContain(Buffer.from(s.access).toString("hex"));
  });

  it("re-encrypts under a new key over the version it read, never over a newer one", async () => {
    const s = await connect(user());
    const p = await forWorkspace(s.workspace, s.actor);
    process.env.APP_ENCRYPTION_KEY = generateCredentialKey();
    process.env.APP_ENCRYPTION_KEY_VERSION = "2";
    process.env.APP_ENCRYPTION_PREVIOUS_KEYS = `1:${KEY_V1}`;
    resetCredentialKeyringForTests();
    try {
      expect(credentialKeyring().currentVersion).toBe(2);
      const { access, refresh } = opened(p);
      const resealed = sealShopCredential(s.id, { accessToken: access, refreshToken: refresh, expiresIn: null, scope: null });
      expect(await svc("reseal_shop_credential", p.shop_id, p.version - 1, resealed)).toBe(false);
      expect(await svc("reseal_shop_credential", p.shop_id, p.version, resealed)).toBe(true);
      const after = await forWorkspace(s.workspace, s.actor);
      expect(after.key_version).toBe(2);
      expect(opened(after).access).toBe(s.access);
      const pending = await svc<{ shop: Array<{ shop_id: string }> }>("credentials_below_key_version", 2, 1000);
      expect(pending.shop.some((c) => c.shop_id === p.shop_id)).toBe(false);
    } finally {
      process.env.APP_ENCRYPTION_KEY = KEY_V1;
      process.env.APP_ENCRYPTION_KEY_VERSION = "1";
      delete process.env.APP_ENCRYPTION_PREVIOUS_KEYS;
      resetCredentialKeyringForTests();
    }
  });

  it("keeps ciphertext tables away from the application role and every client role", async () => {
    for (const table of ["shop_credentials", "workspace_meta_credentials", "workspace_meta_connections"]) {
      const [row] = await q(
        `select has_table_privilege('service_role', $1, 'select') as service, has_table_privilege('anon', $1, 'select') as anon,
                has_table_privilege('authenticated', $1, 'select') as authed, (select relrowsecurity from pg_class where oid = $1::regclass) as rls`,
        [`public.${table}`],
      );
      expect(row, table).toEqual({ service: false, anon: false, authed: false, rls: true });
    }
    for (const fn of ["bind_shop_under_lease(text,uuid,bigint,text,text,uuid,text)", "store_shop_credential(uuid,uuid,jsonb)"]) {
      expect((await q("select has_function_privilege('service_role', $1, 'execute') as ok", [`public.${fn}`]))[0], fn).toEqual({ ok: false });
    }
  });
});
