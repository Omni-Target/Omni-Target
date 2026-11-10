/**
 * Read-only credit integrity report (DATA-02).
 *
 * Every statement runs inside a READ ONLY transaction. Console output never
 * includes full user ids. Reports:
 *   - accounts whose two balance columns disagree;
 *   - packs granted 3/10 credits before 2026-09-03, when "Starter Pack – 5" and
 *     "Growth Pack – 15" were on sale (possible under-credits);
 *   - whether the manual KASA claim exists (formerly referenced by the legacy
 *     reconciliation in billing-db.ts; since task 5 such legacy claims make
 *     the ledger record the charge as legacy_claimed instead of crediting it).
 *
 * Before/after comparison around a change:
 *   node scripts/ops/credit-report.mjs --out before.json
 *   node scripts/ops/credit-report.mjs --compare before.json
 * --out writes full user ids to a local file (mode 600): keep it private.
 *
 * Usage: SUPABASE_DB_URL=postgres://… node scripts/ops/credit-report.mjs
 *        node scripts/ops/credit-report.mjs --env-file .env.local
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const envFile = option("--env-file");
if (envFile && existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Set SUPABASE_DB_URL or pass --env-file.");
  process.exit(2);
}

const mask = (id) => `${String(id).slice(0, 9)}…`;

async function main() {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const q = async (sql, params) => (await client.query(sql, params)).rows;

    const [{ has_credits: hasCredits }] = await q(
      `select exists(select 1 from information_schema.columns
        where table_schema='public' and table_name='user_integrations' and column_name='credits') as has_credits`,
    );
    const balances = await q(
      `select clerk_user_id, ${hasCredits ? "credits" : "null::int as credits"}, credits_balance
         from public.user_integrations order by clerk_user_id`,
    );
    const shown = (row) => row.credits ?? row.credits_balance ?? 0;
    const divergent = balances.filter((r) => hasCredits && (r.credits ?? 0) !== (r.credits_balance ?? 0));
    console.log(`accounts: ${balances.length}; total displayed credits: ${balances.reduce((s, r) => s + shown(r), 0)}`);
    console.log(`accounts with diverged balance columns: ${divergent.length}`);
    for (const r of divergent.slice(0, 25)) {
      console.log(`  ${mask(r.clerk_user_id)} credits=${r.credits} credits_balance=${r.credits_balance}`);
    }

    const legacy = await q(
      `select pack, credits_granted, count(*)::int as purchases
         from public.payments
        where provider = 'shopify' and status = 'success'
          and created_at < '2026-09-03' and pack in ('starter','growth') and credits_granted in (3, 10)
        group by 1, 2 order by 1`,
    );
    console.log(`possible legacy under-credits (5/15-credit packs granted 3/10): ${legacy.length ? "" : "none"}`);
    for (const r of legacy) console.log(`  ${r.pack}: granted ${r.credits_granted} × ${r.purchases}`);

    const [{ count: kasa }] = await q(
      `select count(*)::int as count from public.processed_payments where payment_id like 'shopify:kasa-starter-%'`,
    );
    console.log(`manual KASA claim rows: ${kasa}`);

    const out = option("--out");
    if (out) {
      writeFileSync(out, JSON.stringify(balances.map((r) => [r.clerk_user_id, shown(r)])), { mode: 0o600 });
      console.log(`per-user balances written to ${out}`);
    }
    const compare = option("--compare");
    if (compare) {
      const previous = new Map(JSON.parse(readFileSync(compare, "utf8")));
      const changed = balances.filter((r) => previous.has(r.clerk_user_id) && previous.get(r.clerk_user_id) !== shown(r));
      const added = balances.filter((r) => !previous.has(r.clerk_user_id)).length;
      console.log(`compared with ${compare}: ${changed.length} changed, ${added} new`);
      for (const r of changed.slice(0, 50)) {
        console.log(`  ${mask(r.clerk_user_id)} ${previous.get(r.clerk_user_id)} -> ${shown(r)}`);
      }
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(`Report failed: ${String(err?.message || err).replace(/postgres(ql)?:\/\/\S+/g, "[redacted]")}`);
  process.exit(2);
});
