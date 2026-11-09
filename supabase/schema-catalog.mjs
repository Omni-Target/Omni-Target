#!/usr/bin/env node
/**
 * Deterministic catalog of the `public` schema (Phase 1, task 2).
 *
 *   node supabase/schema-catalog.mjs                 print JSON
 *   node supabase/schema-catalog.mjs --out file      write JSON
 *   node supabase/schema-catalog.mjs --compare file  exit 1 and list every difference
 *
 * Connects with DATABASE_URL. Reads system catalogs and migration IDs only,
 * never table contents. Captures tables, columns, constraints, indexes,
 * functions (with a hash of their body), triggers, policies, sequences, RLS
 * flags and the privileges of the application roles. Operational roles such
 * as the backup role are excluded: they are created per environment.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

const hash = (text) => createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

async function catalog(client) {
  const q = async (sql) => (await client.query(sql)).rows;
  const tables = await q(`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`);
  const columns = await q(`
    select table_name as t, column_name as c, data_type as type, udt_name as udt, is_nullable as nullable,
           column_default as def, is_generated as generated
      from information_schema.columns where table_schema = 'public' order by 1, ordinal_position`);
  const constraints = await q(`
    select conrelid::regclass::text as t, conname as name, contype as type, pg_get_constraintdef(oid) as def
      from pg_constraint where connamespace = 'public'::regnamespace and conrelid <> 0 order by 1, 2`);
  const indexes = await q(`select tablename as t, indexname as name, indexdef as def from pg_indexes where schemaname = 'public' order by 1, 2`);
  const functions = await q(`
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
           pg_get_function_result(p.oid) as returns, l.lanname as language, p.prosecdef as security_definer,
           coalesce(array_to_string(p.proconfig, ','), '') as config, p.prosrc as body,
           coalesce((select string_agg(distinct a.grantee::regrole::text, ',' order by a.grantee::regrole::text)
                       from aclexplode(p.proacl) a
                      where a.privilege_type = 'EXECUTE' and a.grantee <> 0
                        and a.grantee::regrole::text in ('anon', 'authenticated', 'service_role')), '') as execute_roles,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
     where n.nspname = 'public' and p.prokind = 'f' order by 1`);
  const triggers = await q(`
    select tgrelid::regclass::text as t, tgname as name, pg_get_triggerdef(oid) as def
      from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
     order by 1, 2`);
  const policies = await q(`
    select tablename as t, policyname as name, cmd, roles::text as roles, qual, with_check
      from pg_policies where schemaname = 'public' order by 1, 2`);
  const sequences = await q(`select sequence_name as name, data_type as type from information_schema.sequences where sequence_schema = 'public' order by 1`);
  const grants = await q(`
    select table_name as t, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
     group by 1, 2 order by 1, 2`);
  let migrations = null;
  try {
    migrations = (await q(`select id from public.schema_migrations order by id`)).map((row) => row.id);
  } catch {
    migrations = null;
  }
  return {
    server_version_major: Number(String((await q("show server_version_num"))[0].server_version_num).slice(0, 2)),
    tables,
    columns,
    constraints,
    indexes,
    functions: functions.map(({ body, ...rest }) => ({ ...rest, body_sha: hash(body) })),
    triggers,
    policies,
    sequences,
    grants,
    migrations,
  };
}

function difference(expected, actual) {
  const problems = [];
  for (const key of Object.keys(expected)) {
    const a = JSON.stringify(expected[key]);
    const b = JSON.stringify(actual[key]);
    if (a === b) continue;
    if (!Array.isArray(expected[key])) {
      problems.push(`${key}: expected ${a}, found ${b}`);
      continue;
    }
    const left = new Set(expected[key].map((item) => JSON.stringify(item)));
    const right = new Set((actual[key] ?? []).map((item) => JSON.stringify(item)));
    for (const item of left) if (!right.has(item)) problems.push(`${key}: missing ${item}`);
    for (const item of right) if (!left.has(item)) problems.push(`${key}: unexpected ${item}`);
  }
  return problems;
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const local = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query("begin transaction read only");
  const result = await catalog(client);
  await client.query("rollback");
  const compareWith = option("--compare");
  const out = option("--out");
  if (compareWith) {
    const problems = difference(JSON.parse(readFileSync(compareWith, "utf8")), result);
    if (problems.length) {
      console.error(`Schema differs from ${compareWith} in ${problems.length} place(s):`);
      for (const problem of problems.slice(0, 50)) console.error(`  ${problem.slice(0, 300)}`);
      process.exitCode = 1;
    } else {
      console.log(`Schema matches ${compareWith}.`);
    }
  } else if (out) {
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Wrote ${out}: ${result.tables.length} tables, ${result.functions.length} functions, ${result.indexes.length} indexes.`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await client.end();
}
