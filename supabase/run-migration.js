/**
 * Run the full database migration against the new Supabase project.
 * Usage: node supabase/run-migration.js
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

// Load .env.local
const envPath = join(__dirname, "..", ".env.local");
const envContent = readFileSync(envPath, "utf-8");

const env = {};
envContent.split("\n").forEach((line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) return;
  let key = trimmed.slice(0, eqIdx).trim();
  let val = trimmed.slice(eqIdx + 1).trim();
  // Strip surrounding quotes
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  env[key] = val;
});

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

console.log("Supabase URL:", supabaseUrl);
console.log("Service Key:", serviceKey.slice(0, 20) + "...");

// Read the migration SQL
const sqlPath = join(__dirname, "full-migration.sql");
const sql = readFileSync(sqlPath, "utf-8");

async function runMigration() {
  const supabase = createClient(supabaseUrl, serviceKey);

  console.log("\n========================================");
  console.log("  RUNNING FULL DATABASE MIGRATION");
  console.log("========================================\n");

  // Use the Supabase RPC to execute raw SQL via the postgres function
  // We'll use the built-in pg_catalog or run via REST
  // The simplest approach is to use supabase.rpc or the SQL endpoint

  // Split SQL into individual statements and execute them one by one
  // Remove comments and split by semicolons
  const statements = sql
    .replace(/--.*$/gm, "") // Remove single-line comments
    .split(/;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Found ${statements.length} SQL statements to execute.\n`);

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    // Skip empty or comment-only statements
    if (!stmt || stmt.length < 5) continue;

    const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
    console.log(`[${i + 1}/${statements.length}] ${preview}...`);

    try {
      const { error } = await supabase.rpc("exec_sql", { query: stmt });
      if (error) {
        // If RPC doesn't exist, we need the REST approach
        throw error;
      }
      console.log(`   ✓ Success`);
      successCount++;
    } catch (rpcError) {
      // Fallback: use the Supabase Management API / direct postgres
      // For the JS client, we can try using the postgrest approach
      console.log(`   ⚠ RPC not available, will use alternative method`);
      errorCount++;
    }
  }

  console.log(`\n========================================`);
  console.log(`  Migration Summary`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Errors:  ${errorCount}`);
  console.log(`========================================\n`);

  if (errorCount > 0) {
    console.log(
      "NOTE: The Supabase JS client cannot run raw DDL SQL directly.",
    );
    console.log("You need to run the migration via one of these methods:\n");
    console.log("OPTION 1 (Recommended): Supabase SQL Editor");
    console.log(
      "  1. Go to: " +
        supabaseUrl.replace(".supabase.co", "") +
        " → SQL Editor",
    );
    console.log("  2. Copy the contents of supabase/full-migration.sql");
    console.log("  3. Paste into the editor and click 'Run'\n");
    console.log("OPTION 2: Supabase CLI");
    console.log("  npx supabase db push\n");
  }
}

runMigration().catch(console.error);
