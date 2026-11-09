#!/usr/bin/env node
/**
 * Builds a fresh database from the schema baseline plus later migrations
 * (Phase 1, task 2).
 *
 *   DATABASE_URL=postgresql://... node supabase/provision.mjs
 *
 * For empty databases only, such as CI or a local throwaway Postgres. It
 * refuses any database that already has public.schema_migrations, so it can
 * never run against staging or production; existing databases use
 * `node supabase/migrate.mjs up` instead.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "baseline", "0017_schema.sql");
const PRODUCTION_REF = "bafwrcyruaxzojwofxym";
/** Roles a Supabase project already has; a plain Postgres needs them for the baseline's grants. */
const PLATFORM_ROLES = ["anon", "authenticated", "service_role", "supabase_admin"];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
if (url.includes(PRODUCTION_REF)) {
  console.error("Refusing to provision the production project.");
  process.exit(2);
}

const local = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  const { rows } = await client.query("select to_regclass('public.schema_migrations') is not null as present");
  if (rows[0].present) {
    console.error("This database already has public.schema_migrations. Use `node supabase/migrate.mjs up` for existing databases.");
    process.exitCode = 2;
  } else {
    for (const role of PLATFORM_ROLES) {
      await client.query(
        `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then execute format('create role %I nologin', '${role}'); end if; end $$;`,
      );
    }
    await client.query("begin");
    await client.query(readFileSync(BASELINE, "utf8"));
    await client.query("commit");
    console.log("Applied baseline 0017.");
  }
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`Provisioning failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

// --baseline-only stops here, so CI can compare the reconstructed baseline
// exactly before later migrations change it.
if (!process.exitCode && !process.argv.includes("--baseline-only")) {
  // Later migrations run through the normal runner, against this database only.
  const result = spawnSync(process.execPath, [join(HERE, "migrate.mjs"), "up"], {
    env: { ...process.env, SUPABASE_DB_URL: url },
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}
