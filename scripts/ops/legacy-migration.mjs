/**
 * Legacy account migration runner (Phase 1, task 6; migrations 0022/0023).
 *
 *   node scripts/ops/legacy-migration.mjs --expect-ref <project ref> [--apply] [--clear-plaintext --backup-verified] [--out report.json]
 *
 * Default is a dry run: every legacy row is migrated inside one transaction
 * that is then rolled back, so the report shows exactly what an apply would
 * do and nothing is written. --apply commits each row in its own transaction
 * (idempotent: a migrated row is reported, never redone). --clear-plaintext
 * nulls the plaintext credential columns of migrated rows; it is irreversible
 * and needs --backup-verified (scripts/ops/runbooks/backups.md).
 *
 * Connects with DATABASE_URL (or SUPABASE_DB_URL) and refuses any database
 * whose project ref is not --expect-ref ("local" for 127.0.0.1/localhost).
 * The report holds counts and user id suffixes only and is written with mode 600.
 */
import { writeFileSync } from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const expectRef = value("--expect-ref");
const apply = flag("--apply");
const clearPlaintext = flag("--clear-plaintext");
if (!url || !expectRef) {
  console.error("Usage: DATABASE_URL=... node scripts/ops/legacy-migration.mjs --expect-ref <ref> [--apply] [--clear-plaintext --backup-verified] [--out file]");
  process.exit(2);
}
const parsed = new URL(url);
const local = ["127.0.0.1", "localhost"].includes(parsed.hostname);
const user = decodeURIComponent(parsed.username);
const ref = local ? "local" : user.includes(".") ? user.split(".").pop() : parsed.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] ?? null;
if (ref !== expectRef) {
  console.error(`Refusing: the database is project "${ref}", not "${expectRef}".`);
  process.exit(2);
}
if (clearPlaintext && (!apply || !flag("--backup-verified"))) {
  console.error("Refusing: --clear-plaintext is irreversible and needs --apply and --backup-verified.");
  process.exit(2);
}

const run = `${apply ? "apply" : "dry"}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
await client.connect();
const suffix = (id) => `…${String(id).slice(-6)}`;
const report = { run, project: ref, mode: apply ? "apply" : "dry-run", started_at: new Date().toISOString(), rows: [], orphans: null, cleared: [] };

try {
  const rows = (await client.query("select id, clerk_user_id from public.user_integrations order by created_at, id")).rows;
  if (!apply) await client.query("begin");
  for (const row of rows) {
    if (apply) await client.query("begin");
    try {
      const result = (await client.query("select public.migrate_legacy_account($1, $2) as r", [row.id, run])).rows[0].r;
      report.rows.push({ user: suffix(row.clerk_user_id), ...result, workspace_id: result.workspace_id ? suffix(result.workspace_id) : null });
      if (apply) await client.query("commit");
    } catch (error) {
      if (!apply) throw error;
      await client.query("rollback");
      report.rows.push({ user: suffix(row.clerk_user_id), outcome: "failed", error: error.message });
    }
  }
  report.orphans = (await client.query("select public.record_legacy_orphans($1) as r", [run])).rows[0].r;
  if (clearPlaintext) {
    for (const row of rows) {
      const outcome = (await client.query("select public.clear_legacy_plaintext_credentials($1) as r", [row.id])).rows[0].r;
      report.cleared.push({ user: suffix(row.clerk_user_id), outcome });
    }
  }
  if (!apply) await client.query("rollback");
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`Stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

const count = (predicate) => report.rows.filter(predicate).length;
report.summary = {
  legacy_rows: report.rows.length,
  migrated: count((r) => r.outcome === "migrated"),
  already_migrated: count((r) => r.outcome === "already_migrated"),
  failed: count((r) => r.outcome === "failed"),
  claims: report.rows.reduce((acc, r) => ({ ...acc, [r.claim_status ?? "none"]: (acc[r.claim_status ?? "none"] ?? 0) + 1 }), {}),
  opening_balance_total: report.rows.reduce((sum, r) => sum + (r.opening_balance ?? 0), 0),
  opening_needs_review: count((r) => r.opening_needs_review === true),
  purchases_recorded: report.rows.reduce((sum, r) => sum + (r.purchases_recorded ?? 0), 0),
  credentials_retired: count((r) => r.credential === "retired_unbound"),
  plaintext_cleared: report.cleared.filter((c) => c.outcome === "cleared").length,
  orphans: report.orphans,
};
const out = value("--out") ?? `legacy-migration-${run}.json`;
writeFileSync(out, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ mode: report.mode, project: ref, ...report.summary, report: out }, null, 2));
