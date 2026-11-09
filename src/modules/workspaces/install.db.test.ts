/**
 * Real Postgres tests for installation under the per-shop lease (Phase 1,
 * task 3.1). The orchestration under test is the application's own
 * installUnderLease; the database ports call the same functions the app
 * calls, as service_role. Shopify's token endpoint is simulated with its
 * documented behaviour: one current token per app and store, and each code
 * exchange retires the previous one.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { installUnderLease, type InstallPorts, type InstallResult } from "./install";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 30 });
afterAll(() => pool.end());

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

async function asService<T>(fn: string, ...args: unknown[]): Promise<T> {
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

/** Shopify's token endpoint: one current token per store; an exchange retires the previous one. */
class SimulatedShopify {
  private current = new Map<string, string>();
  readonly exchanges: { shop: string; actor: string; token: string }[] = [];
  private gates = new Map<string, Promise<void>>();

  constructor(private readonly ids: Map<string, number>) {}

  /** Holds the exchange for codes issued to this actor until released. */
  hold(actor: string): () => void {
    let release!: () => void;
    this.gates.set(actor, new Promise<void>((resolve) => (release = resolve)));
    return release;
  }

  async exchange(shop: string, code: string) {
    const actor = code.replace(/^code:/, "");
    await sleep(25);
    await this.gates.get(actor);
    const token = `shpat_${actor}_${this.exchanges.length}`;
    this.exchanges.push({ shop, actor, token });
    this.current.set(shop, token);
    return { accessToken: token, refreshToken: `shprt_${token}`, expiresIn: 3600, scope: "read_products" };
  }

  isCurrent(shop: string, token: string | undefined) {
    return token !== undefined && this.current.get(shop) === token;
  }

  identity(shop: string) {
    return { id: this.ids.get(shop)!, myshopifyDomain: shop, name: "Test shop", details: {} };
  }
}

/** Stored credentials, keyed by shop, as the app's persist step writes them. */
type Store = Map<string, { actor: string; token: string }>;

function ports(shopify: SimulatedShopify, store: Store, overrides: Partial<InstallPorts> = {}): InstallPorts {
  return {
    acquireLease: (shop, actor) => asService<string | null>("acquire_shop_lease", `install:${shop}`, "install", actor, 60),
    releaseLease: async (shop, holder) => {
      await asService("release_shop_lease", `install:${shop}`, holder);
    },
    leaseHeld: (shop, holder) => asService<boolean>("shop_lease_held", `install:${shop}`, holder),
    check: async (shop, holder, actor, transferId) =>
      (await asService<{ outcome: never }>("connect_check_under_lease", shop, holder, actor, transferId)).outcome,
    exchangeCode: (shop, code) => shopify.exchange(shop, code),
    fetchShop: async (shop) => shopify.identity(shop),
    commit: (input) =>
      asService("bind_shop_under_lease", input.shop, input.holder, input.identity.id, input.identity.myshopifyDomain,
        input.actor, input.selectedWorkspaceId, input.identity.name),
    persist: async (input) => {
      store.set(input.identity.myshopifyDomain, { actor: input.actor, token: input.token.accessToken });
    },
    sleep,
    ...overrides,
  };
}

const fast = { attempts: 200, pollMs: 15 };
const connect = (shop: string, actor: string, p: InstallPorts) =>
  installUnderLease({ shop, code: `code:${actor}`, actor, selectedWorkspaceId: null, transferId: null }, p, fast);

function setup() {
  const shop = domain();
  const shopify = new SimulatedShopify(new Map([[shop, shopId()]]));
  const store: Store = new Map();
  return { shop, shopify, store, p: ports(shopify, store) };
}

const expireLease = (shop: string) =>
  q("update public.shop_leases set acquired_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where lease_key = $1", [`install:${shop}`]);
const currentOwner = async (shop: string) =>
  (await q<{ owner: string }>(
    `select w.owner_clerk_user_id as owner from public.shop_bindings b join public.shops s on s.id = b.shop_id
       join public.workspaces w on w.id = b.workspace_id where s.myshopify_domain = $1 and b.released_at is null`, [shop],
  ))[0]?.owner;
const workspaceCount = async (owners: string[]) =>
  (await q<{ n: number }>("select count(*)::int as n from public.workspaces where owner_clerk_user_id = any($1)", [owners]))[0].n;

describe("two accounts connecting the same shop at once", () => {
  it("lets only the winner reach the token exchange; the other is refused without a token", async () => {
    const { shop, shopify, store, p } = setup();
    const [a, b] = [user(), user()];
    const results = await Promise.all([connect(shop, a, p), connect(shop, b, p)]);

    const owner = await currentOwner(shop);
    const loser = owner === a ? b : a;
    expect([a, b]).toContain(owner);
    expect(results.map((r) => r.kind).sort()).toEqual(["connected", "refused"]);
    expect(results.find((r) => r.kind === "refused")).toMatchObject({ outcome: "rejected_other_owner", exchanged: false });
    expect(shopify.exchanges.map((e) => e.actor)).toEqual([owner]);
    expect(shopify.exchanges.some((e) => e.actor === loser)).toBe(false);
    expect(shopify.isCurrent(shop, store.get(shop)?.token)).toBe(true);
    expect(await workspaceCount([a, b])).toBe(1);
  });

  it("keeps an existing owner's credential working while another account tries to connect", async () => {
    const { shop, shopify, store, p } = setup();
    const [owner, intruder] = [user(), user()];
    expect((await connect(shop, owner, p)).kind).toBe("connected");
    const ownersToken = store.get(shop)!.token;

    const results = await Promise.all(Array.from({ length: 5 }, () => connect(shop, intruder, p)));
    expect(results.every((r) => r.kind === "refused" && !r.exchanged)).toBe(true);
    expect(shopify.exchanges.filter((e) => e.actor === intruder)).toHaveLength(0);
    expect(shopify.isCurrent(shop, ownersToken)).toBe(true);
    expect(store.get(shop)).toEqual({ actor: owner, token: ownersToken });
  });

  it("creates one workspace and one binding when many callbacks from both accounts race", async () => {
    const { shop, shopify, store, p } = setup();
    const [a, b] = [user(), user()];
    const results = await Promise.all([a, b, a, b, a, b, a, b].map((actor) => connect(shop, actor, p)));

    const owner = await currentOwner(shop);
    expect(shopify.exchanges.every((e) => e.actor === owner)).toBe(true);
    expect(results.filter((r) => r.kind === "refused")).toHaveLength(4);
    expect(await workspaceCount([a, b])).toBe(1);
    expect((await q<{ n: number }>(
      "select count(*)::int as n from public.shop_bindings b join public.shops s on s.id = b.shop_id where s.myshopify_domain = $1", [shop],
    ))[0].n).toBe(1);
    expect(store.get(shop)?.actor).toBe(owner);
    expect(shopify.isCurrent(shop, store.get(shop)?.token)).toBe(true);
  });
});

describe("lease expiry and stale callbacks", () => {
  it("waits for a live lease, and recovers one left behind by a crashed callback", async () => {
    const { shop, store, p } = setup();
    const crashed = await asService<string>("acquire_shop_lease", `install:${shop}`, "install", user(), 60);
    expect(crashed).toBeTruthy();
    const actor = user();
    const blocked = await installUnderLease({ shop, code: `code:${actor}`, actor, selectedWorkspaceId: null, transferId: null }, p, { attempts: 3, pollMs: 10 });
    expect(blocked).toEqual({ kind: "busy" });

    await expireLease(shop);
    expect((await connect(shop, actor, p)).kind).toBe("connected");
    expect(store.get(shop)?.actor).toBe(actor);
    expect(await q("select 1 from public.shop_leases where lease_key = $1", [`install:${shop}`])).toEqual([]);
  });

  it("refuses a stale callback's commit after its lease was taken over", async () => {
    const { shop, shopify, store, p } = setup();
    const [slow, fresh] = [user(), user()];
    const releaseSlow = shopify.hold(slow);
    const slowRun = connect(shop, slow, p);
    while (!(await q("select 1 from public.shop_leases where actor = $1", [slow])).length) await sleep(10);

    // The slow callback's lease expires while Shopify keeps it waiting.
    await expireLease(shop);
    expect((await connect(shop, fresh, p)).kind).toBe("connected");
    releaseSlow();

    expect(await slowRun).toEqual({ kind: "lease_lost", exchanged: true });
    expect(await currentOwner(shop)).toBe(fresh);
    expect(store.get(shop)?.actor).toBe(fresh);
    expect(await workspaceCount([slow])).toBe(0);
  });

  it("never lets a stale callback overwrite the credential of the callback that took over", async () => {
    const { shop, shopify, store } = setup();
    const owner = user();
    let stall!: () => void;
    const stalled = new Promise<void>((resolve) => (stall = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));

    // First callback commits its binding, then stalls before storing its token.
    const first = installUnderLease(
      { shop, code: `code:${owner}`, actor: owner, selectedWorkspaceId: null, transferId: null },
      ports(shopify, store, {
        leaseHeld: async (s, holder) => {
          stall();
          await resumed;
          return asService<boolean>("shop_lease_held", `install:${s}`, holder);
        },
      }),
      fast,
    );
    await stalled;
    await expireLease(shop);
    const second = await connect(shop, owner, ports(shopify, store));
    expect(second.kind).toBe("connected");
    const newest = store.get(shop)!.token;
    resume();

    expect((await first).kind).toBe("lease_lost");
    expect(store.get(shop)!.token).toBe(newest);
    expect(shopify.isCurrent(shop, newest)).toBe(true);
  });
});

describe("lease primitives", () => {
  it("grants a key to exactly one of many simultaneous callers", async () => {
    const key = `install:${domain()}`;
    const holders = await Promise.all(Array.from({ length: 20 }, () => asService<string | null>("acquire_shop_lease", key, "install", user(), 60)));
    expect(holders.filter(Boolean)).toHaveLength(1);
  });

  it("releases only for its own holder", async () => {
    const key = `install:${domain()}`;
    const holder = await asService<string>("acquire_shop_lease", key, "install", user(), 60);
    expect(await asService("release_shop_lease", key, "00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(await asService("shop_lease_held", key, holder)).toBe(true);
    expect(await asService("release_shop_lease", key, holder)).toBe(true);
  });

  it("refuses a check or commit without the lease", async () => {
    const shop = domain();
    const nobody = "00000000-0000-4000-8000-000000000000";
    expect((await asService<{ outcome: string }>("connect_check_under_lease", shop, nobody, user(), null)).outcome).toBe("rejected_lease_lost");
    expect((await asService<{ outcome: string }>("bind_shop_under_lease", shop, nobody, shopId(), shop, user(), null, null)).outcome)
      .toBe("rejected_lease_lost");
  });
});

describe("shop/update", () => {
  it("follows a myshopify domain change so the owner is still found before the next exchange", async () => {
    const { shop, shopify, store, p } = setup();
    const [owner, intruder] = [user(), user()];
    expect((await connect(shop, owner, p)).kind).toBe("connected");
    const id = shopify.identity(shop).id;
    const renamed = domain();

    expect(await asService("record_shop_update", id, renamed, "Renamed")).toEqual({ outcome: "domain_updated" });
    const renamedShopify = new SimulatedShopify(new Map([[renamed, id]]));
    const refused: InstallResult = await connect(renamed, intruder, ports(renamedShopify, store));
    expect(refused).toMatchObject({ kind: "refused", outcome: "rejected_other_owner", exchanged: false });
    expect(renamedShopify.exchanges).toHaveLength(0);
    expect(await asService("record_shop_update", id, renamed, null)).toEqual({ outcome: "unchanged" });
  });
});
