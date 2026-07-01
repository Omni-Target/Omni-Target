/**
 * Supabase/Postgres migration runner (migrate-mongo style).
 *
 * Commands:
 *   node supabase/migrate.mjs up        Apply all pending migrations (default)
 *   node supabase/migrate.mjs status    Show applied / pending migrations
 *   node supabase/migrate.mjs down      Roll back the last applied migration
 *   node supabase/migrate.mjs create <name>   Scaffold the next migration file
 *
 * Migrations live in supabase/migrations/NNNN_name.sql and are applied in
 * filename order. Each is run inside its own transaction and recorded in the
 * public.schema_migrations table, so it runs exactly once. An optional
 * companion supabase/migrations/NNNN_name.down.sql enables `down`.
 *
 * Requires a direct Postgres connection string (the Supabase service-role key
 * cannot run DDL). Set SUPABASE_DB_URL (or DATABASE_URL / POSTGRES_URL) in
 * .env.local — see supabase/migrations/README.md.
 */
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(__dirname, "migrations");

/** Load .env.local into process.env without overriding already-set vars. */
function loadEnvLocal() {
  const envPath = join(ROOT, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function getConnectionString() {
  return (
    process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    null
  );
}

function migrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();
}

const migrationId = (file) => basename(file, ".sql");

async function ensureTable(client) {
  await client.query(`
    create table if not exists public.schema_migrations (
      id          text primary key,
      applied_at  timestamptz not null default now()
    );
  `);
}

async function appliedIds(client) {
  const { rows } = await client.query(
    "select id from public.schema_migrations order by id",
  );
  return new Set(rows.map((r) => r.id));
}

/** Connect, run `fn`, always close. Exits with guidance if no connection string. */
async function withClient(fn) {
  const connectionString = getConnectionString();
  if (!connectionString) {
    console.error(
      "\n✗ No database connection string found.\n\n" +
        "  Add SUPABASE_DB_URL to .env.local. In the Supabase dashboard:\n" +
        "    Project Settings → Database → Connection string → Session pooler (URI)\n" +
        "  and put your database password into it. Example:\n" +
        "    SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres\n\n" +
        "  (Use the Session pooler or Direct connection — not the transaction\n" +
        "  pooler on port 6543, which doesn't support migration transactions.)\n",
    );
    process.exit(1);
  }
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function up() {
  await withClient(async (client) => {
    await ensureTable(client);
    const applied = await appliedIds(client);
    const pending = migrationFiles().filter((f) => !applied.has(migrationId(f)));

    if (pending.length === 0) {
      console.log("✓ Up to date — no pending migrations.");
      return;
    }

    console.log(`Applying ${pending.length} pending migration(s)...\n`);
    for (const file of pending) {
      const id = migrationId(file);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      process.stdout.write(`  → ${id} ... `);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          "insert into public.schema_migrations (id) values ($1)",
          [id],
        );
        await client.query("commit");
        console.log("done");
      } catch (err) {
        await client.query("rollback");
        console.log("FAILED");
        console.error(
          `\n✗ Migration "${id}" failed and was rolled back:\n  ${err.message}\n`,
        );
        process.exit(1);
      }
    }
    console.log("\n✓ All migrations applied.");
  });
}

async function down() {
  await withClient(async (client) => {
    await ensureTable(client);
    const { rows } = await client.query(
      "select id from public.schema_migrations order by id desc limit 1",
    );
    if (rows.length === 0) {
      console.log("No applied migrations to roll back.");
      return;
    }
    const id = rows[0].id;
    const downFile = join(MIGRATIONS_DIR, `${id}.down.sql`);
    if (!existsSync(downFile)) {
      console.error(
        `✗ No down script for "${id}" (expected ${id}.down.sql).\n` +
          "  Add one to enable rollback of this migration.",
      );
      process.exit(1);
    }
    console.log(`Rolling back "${id}"...`);
    try {
      await client.query("begin");
      await client.query(readFileSync(downFile, "utf-8"));
      await client.query("delete from public.schema_migrations where id = $1", [
        id,
      ]);
      await client.query("commit");
      console.log("✓ Rolled back.");
    } catch (err) {
      await client.query("rollback");
      console.error(`\n✗ Rollback of "${id}" failed:\n  ${err.message}\n`);
      process.exit(1);
    }
  });
}

async function status() {
  await withClient(async (client) => {
    await ensureTable(client);
    const applied = await appliedIds(client);
    const files = migrationFiles();

    if (files.length === 0) {
      console.log("No migration files found in supabase/migrations/.");
      return;
    }

    console.log("Migration status  ([x] applied, [ ] pending)\n");
    for (const file of files) {
      const id = migrationId(file);
      console.log(`  [${applied.has(id) ? "x" : " "}] ${id}`);
    }
    const pending = files.filter((f) => !applied.has(migrationId(f))).length;
    console.log(`\n${files.length} migration(s), ${pending} pending.`);
  });
}

function create(name) {
  if (!name) {
    console.error('Usage: node supabase/migrate.mjs create "<name>"');
    process.exit(1);
  }
  const maxNum = migrationFiles().reduce((max, f) => {
    const m = f.match(/^(\d+)/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  const seq = String(maxNum + 1).padStart(4, "0");
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  const file = join(MIGRATIONS_DIR, `${seq}_${slug}.sql`);
  if (existsSync(file)) {
    console.error(`✗ ${file} already exists.`);
    process.exit(1);
  }
  writeFileSync(file, `-- ${seq}_${slug}\n-- Describe the change here.\n\n`);
  console.log(`Created supabase/migrations/${seq}_${slug}.sql`);
}

loadEnvLocal();
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "up":
    await up();
    break;
  case "down":
    await down();
    break;
  case "status":
    await status();
    break;
  case "create":
    create(args[0]);
    break;
  default:
    console.error(
      `Unknown command "${cmd}". Use: up | down | status | create <name>`,
    );
    process.exit(1);
}
