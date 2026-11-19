/**
 * Real Postgres tests for import capacity reservations (Phase 2, task 5;
 * migration 0033). Synthetic rows only; quotas are set relative to the test
 * database's own size.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 10 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const MB = 1024 * 1024;

async function asService(client, sql, params) {
  await client.query("set role service_role");
  try {
    return (await client.query(sql, params)).rows[0].result;
  } finally {
    await client.query("reset role");
  }
}
const call = async (fn, ...args) => {
  const client = await pool.connect();
  try {
    return await asService(client, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args);
  } finally {
    client.release();
  }
};

let counter = 0;
async function newShop() {
  const tag = `${Date.now().toString(36)}${(counter++).toString(36)}`;
  return (await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning shop_key",
    [Math.floor(Math.random() * 9e12) + 1e12, `cap-${tag}.myshopify.com`])).shop_key;
}
const dbSize = async () => Number((await one("select pg_database_size(current_database()) as b")).b);
/** A quota whose limit (share 1) leaves exactly `room` bytes free above today's size. */
const quotaWithRoom = async (room) => (await dbSize()) + room;

beforeEach(async () => {
  await q("update public.capacity_reservations set released_at = now(), release_reason = 'cancelled' where released_at is null");
});

describe("capacity reservations (Phase 2 task 5)", () => {
  it("grants a reservation that fits and refuses one that would pass the limit, counting what is outstanding", async () => {
    const [a, b] = [await newShop(), await newShop()];
    const quota = await quotaWithRoom(100 * MB);
    const first = await call("reserve_import_capacity", a, "initial_import", 60 * MB, quota, 1, 3600, {});
    expect(first).toMatchObject({ outcome: "reserved", existing: false });
    const second = await call("reserve_import_capacity", b, "initial_import", 60 * MB, quota, 1, 3600, {});
    expect(second).toMatchObject({ outcome: "refused", reason: "capacity_exceeded", outstanding_bytes: 60 * MB, requested_bytes: 60 * MB });
  });

  it("serialises reservations made at the same moment: the second waits for the first and is refused", async () => {
    const [a, b] = [await newShop(), await newShop()];
    const quota = await quotaWithRoom(100 * MB);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("begin");
      expect(await asService(first, "select public.reserve_import_capacity($1, 'initial_import', $2, $3, 1, 3600, '{}') as result", [a, 60 * MB, quota]))
        .toMatchObject({ outcome: "reserved" });
      let settled = false;
      const pending = asService(second, "select public.reserve_import_capacity($1, 'initial_import', $2, $3, 1, 3600, '{}') as result", [b, 60 * MB, quota])
        .finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await first.query("commit");
      expect(await pending).toMatchObject({ outcome: "refused", outstanding_bytes: 60 * MB });
    } finally {
      first.release();
      second.release();
    }
  });

  it("returns the active reservation to a retry for the same shop and purpose instead of granting a second", async () => {
    const shop = await newShop();
    const quota = await quotaWithRoom(100 * MB);
    const first = await call("reserve_import_capacity", shop, "initial_import", 60 * MB, quota, 1, 3600, {});
    const retry = await call("reserve_import_capacity", shop, "initial_import", 60 * MB, quota, 1, 3600, {});
    expect(retry).toMatchObject({ outcome: "reserved", existing: true, reservation_id: first.reservation_id });
    expect(await one("select count(*)::int as n from public.capacity_reservations where released_at is null")).toEqual({ n: 1 });
  });

  it("counts written bytes once, and tells a running import when the database has passed the limit", async () => {
    const [a, b] = [await newShop(), await newShop()];
    const quota = await quotaWithRoom(100 * MB);
    const { reservation_id: id } = await call("reserve_import_capacity", a, "initial_import", 60 * MB, quota, 1, 3600, {});
    expect(await call("renew_import_capacity", id, 50 * MB, quota, 1, 3600)).toMatchObject({ outcome: "renewed", written_bytes: 50 * MB, over_limit: false });
    // 10 MB outstanding now, so another 60 MB fits.
    expect(await call("reserve_import_capacity", b, "initial_import", 60 * MB, quota, 1, 3600, {})).toMatchObject({ outcome: "reserved" });
    // Progress never goes backwards.
    expect(await call("renew_import_capacity", id, 10 * MB, quota, 1, 3600)).toMatchObject({ written_bytes: 50 * MB });
    // Against a quota the database already exceeds, the import is told to stop.
    expect(await call("renew_import_capacity", id, 50 * MB, MB, 1, 3600)).toMatchObject({ outcome: "renewed", over_limit: true });
  });

  it("expires a reservation abandoned by a crashed worker, freeing its capacity", async () => {
    const [a, b] = [await newShop(), await newShop()];
    const quota = await quotaWithRoom(100 * MB);
    const { reservation_id: id } = await call("reserve_import_capacity", a, "initial_import", 60 * MB, quota, 1, 60, {});
    await q("update public.capacity_reservations set expires_at = created_at + interval '1 second' where id = $1", [id]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await call("reserve_import_capacity", b, "initial_import", 60 * MB, quota, 1, 3600, {})).toMatchObject({ outcome: "reserved" });
    expect(await one("select release_reason from public.capacity_reservations where id = $1", [id])).toEqual({ release_reason: "expired" });
    expect(await call("renew_import_capacity", id, 0, quota, 1, 3600)).toMatchObject({ outcome: "released" });
  });

  it("releases once, and rejects malformed requests", async () => {
    const shop = await newShop();
    const quota = await quotaWithRoom(100 * MB);
    const { reservation_id: id } = await call("reserve_import_capacity", shop, "initial_import", MB, quota, 1, 3600, {});
    expect(await call("release_import_capacity", id, "completed")).toEqual({ outcome: "released" });
    expect(await call("release_import_capacity", id, "failed")).toEqual({ outcome: "already_released" });
    await expect(call("reserve_import_capacity", shop, "initial_import", 0, quota, 1, 3600, {})).rejects.toThrow(/capacity_request_invalid/);
    await expect(call("reserve_import_capacity", shop, "initial_import", MB, quota, 1.5, 3600, {})).rejects.toThrow(/capacity_request_invalid/);
    await expect(call("reserve_import_capacity", 0, "initial_import", MB, quota, 1, 3600, {})).rejects.toThrow(/shop_not_found/);
  });

  it("lets only service_role reserve, renew and release, and only read the table", async () => {
    for (const fn of [
      "reserve_import_capacity(integer, text, bigint, bigint, numeric, integer, jsonb)",
      "renew_import_capacity(uuid, bigint, bigint, numeric, integer)",
      "release_import_capacity(uuid, text)",
    ]) {
      expect(await one(`select has_function_privilege('service_role', $1, 'execute') as service,
          has_function_privilege('anon', $1, 'execute') or has_function_privilege('authenticated', $1, 'execute') as public_exec`, [`public.${fn}`]), fn)
        .toEqual({ service: true, public_exec: false });
    }
    expect(await one(`select has_table_privilege('service_role', 'public.capacity_reservations', 'select') as read,
        has_table_privilege('service_role', 'public.capacity_reservations', 'insert') as write`)).toEqual({ read: true, write: false });
  });
});
