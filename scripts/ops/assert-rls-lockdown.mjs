/**
 * Read-only assertion that the public schema is locked down for client API
 * roles (verifies migration 0012_rls_lockdown, Phase S0.2 / SEC-02).
 *
 * Exits 0 when compliant, 1 when any violation is found, 2 on error.
 * Every statement runs inside a READ ONLY transaction that is rolled back.
 *
 * Checks:
 *   1. Every table in `public` has row-level security enabled.
 *   2. anon / authenticated hold no privileges on any relation or sequence.
 *   3. anon / authenticated can EXECUTE no function except the allowlist.
 *   4. No default privileges the migration role controls grant anything to
 *      anon / authenticated (platform-owned ones are reported as warnings).
 *   5. service_role bypasses RLS and can EXECUTE every public function.
 *
 * Usage:
 *   node scripts/ops/assert-rls-lockdown.mjs [--env-file .env.local]
 *   SUPABASE_DB_URL=postgres://… node scripts/ops/assert-rls-lockdown.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const CLIENT_ROLES = ["anon", "authenticated"];
const ANON_FUNCTION_ALLOWLIST = new Set(["keepalive_ping()"]);

const args = process.argv.slice(2);
const envFileIndex = args.indexOf("--env-file");
const envFile = envFileIndex !== -1 && args[envFileIndex + 1] ? args[envFileIndex + 1] : ".env.local";

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const connectionString =
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL;

if (!connectionString) {
  console.error("No database connection string found.");
  process.exit(2);
}

async function main() {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const violations = [];
  const warnings = [];
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");

    const present = new Set(
      (await q(`select rolname from pg_roles where rolname = any($1)`, [[...CLIENT_ROLES, "service_role"]])).map(
        (r) => r.rolname,
      ),
    );
    const clientRoles = CLIENT_ROLES.filter((r) => present.has(r));

    // 1. RLS on every table
    for (const r of await q(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
       order by 1`)) {
      violations.push(`RLS disabled on public.${r.relname}`);
    }

    for (const role of clientRoles) {
      // 2a. relation privileges
      for (const r of await q(
        `select c.relname,
                array_remove(array[
                  case when has_table_privilege($1, c.oid, 'SELECT') then 'SELECT' end,
                  case when has_table_privilege($1, c.oid, 'INSERT') then 'INSERT' end,
                  case when has_table_privilege($1, c.oid, 'UPDATE') then 'UPDATE' end,
                  case when has_table_privilege($1, c.oid, 'DELETE') then 'DELETE' end,
                  case when has_table_privilege($1, c.oid, 'TRUNCATE') then 'TRUNCATE' end,
                  case when has_table_privilege($1, c.oid, 'REFERENCES') then 'REFERENCES' end,
                  case when has_table_privilege($1, c.oid, 'TRIGGER') then 'TRIGGER' end
                ], null) as privs
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
          order by 1`,
        [role],
      )) {
        if (r.privs.length) violations.push(`${role} has ${r.privs.join("/")} on public.${r.relname}`);
      }

      // 2b. sequence privileges
      for (const r of await q(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'S'
            and (has_sequence_privilege($1, c.oid, 'USAGE') or has_sequence_privilege($1, c.oid, 'SELECT')
                 or has_sequence_privilege($1, c.oid, 'UPDATE'))`,
        [role],
      )) {
        violations.push(`${role} has privileges on sequence public.${r.relname}`);
      }

      // 3. function EXECUTE
      for (const r of await q(
        `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind in ('f', 'p')
            and has_function_privilege($1, p.oid, 'EXECUTE')
          order by 1`,
        [role],
      )) {
        const allowed = role === "anon" && ANON_FUNCTION_ALLOWLIST.has(r.sig);
        if (!allowed) violations.push(`${role} can EXECUTE public.${r.sig}`);
      }

      // 4. default privileges. Ones held by a grantor the connected (migration)
      //    role can act for are violations: 0012 should have removed them. Ones
      //    held by a role it cannot act for — on Supabase, the platform
      //    superuser supabase_admin — cannot be revoked by any migration; they
      //    are reported as warnings, and any object such a role creates is
      //    still caught by checks 1–3 above.
      for (const r of await q(
        `select d.defaclobjtype as objtype, a.privilege_type,
                pg_get_userbyid(d.defaclrole) as grantor,
                (d.defaclrole = (select oid from pg_roles where rolname = current_user)
                  or pg_has_role(current_user, d.defaclrole, 'MEMBER')) as revocable
           from pg_default_acl d
           join pg_namespace n on n.oid = d.defaclnamespace
           cross join lateral aclexplode(d.defaclacl) a
           join pg_roles g on g.oid = a.grantee
          where n.nspname = 'public' and g.rolname = $1`,
        [role],
      )) {
        const msg = `default privileges of ${r.grantor} grant ${r.privilege_type} on future ${r.objtype} objects to ${role}`;
        if (r.revocable) violations.push(msg);
        else warnings.push(`${msg} (not revocable by the migration role)`);
      }
    }

    // 5. service_role still works
    if (present.has("service_role")) {
      const [sr] = await q(`select rolbypassrls from pg_roles where rolname = 'service_role'`);
      if (!sr.rolbypassrls) violations.push("service_role does not bypass RLS (server queries would be blocked)");
      for (const r of await q(`
        select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind in ('f', 'p')
           and p.prorettype <> 'trigger'::regtype
           and not has_function_privilege('service_role', p.oid, 'EXECUTE')`)) {
        violations.push(`service_role cannot EXECUTE public.${r.sig}`);
      }
    } else {
      violations.push("service_role role not found");
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }

  const printWarnings = () => {
    if (!warnings.length) return;
    const grantors = [...new Set(warnings.map((w) => w.split(" ")[3]))].join(", ");
    console.log(
      `WARN: ${warnings.length} default privilege(s) held by ${grantors} cannot be revoked by migrations. ` +
        "Objects that role creates in public would receive client-role access; checks 1-3 catch any such object, so run this after every schema change.",
    );
  };
  if (violations.length) {
    console.log(`FAIL: ${violations.length} lockdown violation(s)`);
    for (const v of violations) console.log(`  - ${v}`);
    printWarnings();
    process.exit(1);
  }
  console.log("PASS: public schema is locked down for anon/authenticated; service_role intact.");
  printWarnings();
}

main().catch((err) => {
  const msg = String(err?.message || err).replace(/postgres(ql)?:\/\/\S+/g, "[redacted]");
  console.error(`Assertion run failed: ${err?.code || ""} ${msg}`);
  process.exit(2);
});
