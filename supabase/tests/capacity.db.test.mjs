/**
 * Real Postgres tests for capacity snapshots (Phase 1, task 10): migration 0027.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 4 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

async function asService(sql, params) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const QUOTA = 500 * 1024 * 1024;

describe("capacity snapshots (task 10)", () => {
  it("records the database size, quota and largest tables, and returns the share used", async () => {
    const [{ r }] = await asService("select public.capture_capacity_snapshot($1) as r", [QUOTA]);
    expect(r.database_bytes).toBeGreaterThan(0);
    expect(r.quota_bytes).toBe(QUOTA);
    expect(r.used_share).toBeCloseTo(r.database_bytes / QUOTA, 3);
    expect(r.largest.length).toBeGreaterThan(0);

    const row = await one("select database_bytes, public_bytes, quota_bytes, tables from public.db_capacity_snapshots order by id desc limit 1");
    expect(Number(row.database_bytes)).toBe(r.database_bytes);
    expect(Number(row.public_bytes)).toBeLessThanOrEqual(Number(row.database_bytes));
    expect(row.tables.length).toBeLessThanOrEqual(30);
    const totals = row.tables.map((t) => Number(t.total));
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(Object.keys(row.tables[0]).sort()).toEqual(["heap", "indexes", "rows", "table", "total"]);
  });

  it("requires a quota, and keeps 400 days of history", async () => {
    await expect(asService("select public.capture_capacity_snapshot(0)")).rejects.toThrow("quota_required");
    await q("insert into public.db_capacity_snapshots (captured_at, database_bytes, public_bytes, quota_bytes, tables) values (now() - interval '401 days', 1, 1, 1, '[]')");
    await asService("select public.capture_capacity_snapshot($1)", [QUOTA]);
    expect((await one("select count(*)::int as n from public.db_capacity_snapshots where captured_at < now() - interval '400 days'")).n).toBe(0);
  });

  it("gives the pre-flight check the current size", async () => {
    const [{ size }] = await asService("select public.database_size_bytes() as size");
    expect(Number(size)).toBeGreaterThan(0);
  });

  it("lets only the service role capture and read, never write directly", async () => {
    for (const fn of ["capture_capacity_snapshot(bigint)", "database_size_bytes()"]) {
      expect(await one(
        `select has_function_privilege('service_role', $1, 'execute') as service, has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authed`, [`public.${fn}`])).toEqual({ service: true, anon: false, authed: false });
    }
    expect(await one(
      `select c.relrowsecurity as rls, has_table_privilege('service_role', c.oid, 'select') as read, has_table_privilege('service_role', c.oid, 'insert') as write,
              has_table_privilege('anon', c.oid, 'select') as anon from pg_class c where c.oid = 'public.db_capacity_snapshots'::regclass`))
      .toEqual({ rls: true, read: true, write: false, anon: false });
  });
});
