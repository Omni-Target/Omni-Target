/**
 * Real Postgres tests for the import's statistics refresh (migration 0045).
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

async function as(role, sql, params) {
  const client = await pool.connect();
  try {
    await client.query(`set role ${role}`);
    return (await client.query(sql, params)).rows;
  } finally {
    await client.query("reset role").catch(() => {});
    client.release();
  }
}
const analyses = async (table) =>
  Number((await pool.query("select analyze_count + autoanalyze_count as n from pg_stat_user_tables where relname = $1", [table])).rows[0].n);

describe("refresh_mirror_statistics (0045)", () => {
  it("analyses each mirror table the import writes, as the service role", async () => {
    for (const table of ["orders", "order_line_items", "refunds", "customers", "products", "returns", "return_line_items", "history_stage_orders", "history_stage_lines"]) {
      const before = await analyses(table);
      const [{ result }] = await as("service_role", "select public.refresh_mirror_statistics($1) as result", [table]);
      expect(result).toMatchObject({ table });
      // The statistics collector reports asynchronously; give it a moment.
      for (let i = 0; i < 20 && (await analyses(table)) <= before; i++) await new Promise((r) => setTimeout(r, 100));
      expect(await analyses(table), table).toBeGreaterThan(before);
    }
  });

  it("refuses any other table or input, and any other role", async () => {
    for (const table of ["shops", "credit_ledger", "shop_credentials", "orders; drop table public.orders", "", null]) {
      await expect(as("service_role", "select public.refresh_mirror_statistics($1)", [table])).rejects.toThrow(/statistics_table_not_allowed/);
    }
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.refresh_mirror_statistics('orders')")).rejects.toThrow(/permission denied/);
    }
  });
});
