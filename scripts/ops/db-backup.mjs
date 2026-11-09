/**
 * Encrypted PostgreSQL backups to R2 (S2.3, DATA-04). An interim Free-plan
 * safeguard, not point-in-time recovery.
 *
 *   backup        pg_dump -> age encrypt -> upload (needs write access only)
 *   verify        read the newest backup back and check size and checksum
 *   prune         apply retention (14 daily, 8 weekly, 6 monthly)
 *   restore-test  download newest -> decrypt -> restore into a throwaway
 *                 database -> compare row counts with the manifest
 *
 * Common: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * BACKUP_R2_BUCKET, BACKUP_PREFIX.
 * backup: BACKUP_DATABASE_URL (read-only role), BACKUP_AGE_RECIPIENT.
 * restore-test: BACKUP_AGE_IDENTITY_FILE, RESTORE_DATABASE_URL.
 * Needs pg_dump, pg_restore and age on PATH.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const FORBIDDEN_BUCKETS = new Set(["omni-target-assets"]);
const RETENTION_DAYS = { daily: 14, weekly: 8 * 7, monthly: 6 * 31 };
const DAY_MS = 86_400_000;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const redact = (text) => String(text).replace(/postgres(ql)?:\/\/\S+/g, "[redacted-url]");
const isLocalHost = (host) => host === "127.0.0.1" || host === "localhost";

function s3() {
  const endpoint = new URL(required("R2_ENDPOINT"));
  return new S3Client({
    region: "auto",
    endpoint: endpoint.origin,
    // A local S3-compatible store used for testing has no per-bucket hostnames.
    forcePathStyle: isLocalHost(endpoint.hostname),
    credentials: { accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function target() {
  const bucket = required("BACKUP_R2_BUCKET");
  if (FORBIDDEN_BUCKETS.has(bucket)) throw new Error(`Refusing to use bucket ${bucket}`);
  const prefix = required("BACKUP_PREFIX").replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("BACKUP_PREFIX must not be empty");
  return { bucket, prefix };
}

function connectionParts(url) {
  const u = new URL(url);
  return {
    args: ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username), "-d", u.pathname.slice(1) || "postgres"],
    env: { PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: isLocalHost(u.hostname) ? "disable" : "require" },
  };
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function run(command, args, { input, output, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: [input ? "pipe" : "ignore", output ? "pipe" : "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const streams = [];
    if (input) streams.push(pipeline(createReadStream(input), child.stdin));
    if (output) streams.push(pipeline(child.stdout, createWriteStream(output, { mode: 0o600 })));
    child.on("error", reject);
    child.on("close", async (code) => {
      await Promise.allSettled(streams);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${redact(stderr).slice(0, 600)}`));
    });
  });
}

async function withClient(url, fn) {
  const local = isLocalHost(new URL(url).hostname);
  const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function creditSum(client) {
  const { rows } = await client.query("select coalesce(sum(credits_balance), 0)::bigint as total from public.user_integrations");
  return Number(rows[0].total);
}

async function tableCounts(client) {
  const { rows } = await client.query(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`,
  );
  const counts = {};
  for (const { name } of rows) {
    const result = await client.query(`select count(*)::int as n from public."${name.replaceAll('"', '""')}"`);
    counts[name] = result.rows[0].n;
  }
  return counts;
}

function upload(client, bucket, key, path, contentType) {
  return client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(path), ContentLength: statSync(path).size, ContentType: contentType }),
  );
}

async function download(client, bucket, key, path) {
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(object.Body, createWriteStream(path, { mode: 0o600 }));
}

async function listKeys(client, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map((item) => item.Key));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function newestManifest(client, bucket, prefix, dir) {
  const keys = (await listKeys(client, bucket, `${prefix}/daily/`)).filter((key) => key.endsWith(".manifest.json")).sort();
  if (!keys.length) throw new Error("No backups found");
  const manifestKey = keys.at(-1);
  const path = join(dir, "manifest.json");
  await download(client, bucket, manifestKey, path);
  return { manifest: JSON.parse(readFileSync(path, "utf8")), dumpKey: manifestKey.replace(/\.manifest\.json$/, ".dump.age") };
}

async function backup() {
  const { bucket, prefix } = target();
  const databaseUrl = required("BACKUP_DATABASE_URL");
  // Comma-separated: the offline custodian key plus the restore-test key.
  const recipients = required("BACKUP_AGE_RECIPIENT").split(",").map((value) => value.trim()).filter(Boolean);
  const client = s3();
  const dir = mkdtempSync(join(tmpdir(), "omni-backup-"));
  try {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const plain = join(dir, "db.dump");
    const encrypted = join(dir, "db.dump.age");
    const { args, env } = connectionParts(databaseUrl);

    // Counts and dump share one snapshot, so the manifest describes exactly
    // what was dumped even while the application keeps writing.
    const measured = await withClient(databaseUrl, async (db) => {
      await db.query("begin isolation level repeatable read read only");
      const snapshot = (await db.query("select pg_export_snapshot() as id")).rows[0].id;
      const result = {
        server_version: (await db.query("show server_version")).rows[0].server_version,
        database_size_bytes: Number((await db.query("select pg_database_size(current_database()) as size")).rows[0].size),
        table_row_counts: await tableCounts(db),
        credit_balance_sum: await creditSum(db),
      };
      await run("pg_dump", ["-Fc", "--no-owner", "--no-privileges", "--schema=public", `--snapshot=${snapshot}`, ...args], { output: plain, env });
      await db.query("commit");
      return result;
    });

    const dumpSha = await sha256(plain);
    await run("age", [...recipients.flatMap((value) => ["-r", value]), "-o", encrypted, plain]);
    rmSync(plain);

    const manifest = {
      ...measured,
      created_at: now.toISOString(),
      dump_sha256: dumpSha,
      encrypted_sha256: await sha256(encrypted),
      encrypted_bytes: statSync(encrypted).size,
    };
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

    const tiers = ["daily"];
    if (now.getUTCDay() === 0) tiers.push("weekly");
    if (now.getUTCDate() === 1) tiers.push("monthly");
    for (const tier of tiers) {
      const stem = `${prefix}/${tier}/${date}/omnitarget`;
      await upload(client, bucket, `${stem}.dump.age`, encrypted, "application/octet-stream");
      await upload(client, bucket, `${stem}.manifest.json`, manifestPath, "application/json");
    }
    console.log(JSON.stringify({ ok: true, date, tiers, bytes: manifest.encrypted_bytes, tables: Object.keys(manifest.table_row_counts).length }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function verify() {
  const { bucket, prefix } = target();
  const client = s3();
  const dir = mkdtempSync(join(tmpdir(), "omni-verify-"));
  try {
    const { manifest, dumpKey } = await newestManifest(client, bucket, prefix, dir);
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: dumpKey }));
    if (head.ContentLength !== manifest.encrypted_bytes) throw new Error("Stored size does not match the manifest");
    const copy = join(dir, "copy.age");
    await download(client, bucket, dumpKey, copy);
    if ((await sha256(copy)) !== manifest.encrypted_sha256) throw new Error("Stored checksum does not match the manifest");
    if (readFileSync(copy).subarray(0, 21).toString() !== "age-encryption.org/v1") throw new Error("Stored object is not age-encrypted");
    const ageHours = (Date.now() - Date.parse(manifest.created_at)) / 3_600_000;
    console.log(JSON.stringify({ ok: true, created_at: manifest.created_at, age_hours: Number(ageHours.toFixed(1)), bytes: manifest.encrypted_bytes }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function prune() {
  const { bucket, prefix } = target();
  const client = s3();
  const now = Date.now();
  let removed = 0;
  let kept = 0;
  for (const [tier, days] of Object.entries(RETENTION_DAYS)) {
    const dated = (await listKeys(client, bucket, `${prefix}/${tier}/`))
      .map((key) => ({ key, date: key.match(/\/(\d{4}-\d{2}-\d{2})\//)?.[1] }))
      .filter((item) => item.date);
    // The newest backup always survives, so a long outage cannot prune to zero.
    const newest = dated.map((item) => item.date).sort().at(-1);
    for (const { key, date } of dated) {
      if (date !== newest && now - Date.parse(`${date}T00:00:00Z`) > days * DAY_MS) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        removed++;
      } else kept++;
    }
  }
  console.log(JSON.stringify({ ok: true, removed, kept }));
}

async function restoreTest() {
  const { bucket, prefix } = target();
  const restoreUrl = required("RESTORE_DATABASE_URL");
  const identity = required("BACKUP_AGE_IDENTITY_FILE");
  if (!isLocalHost(new URL(restoreUrl).hostname)) throw new Error("restore-test only runs against a local disposable Postgres");

  const client = s3();
  const dir = mkdtempSync(join(tmpdir(), "omni-restore-"));
  const database = `restore_test_${Date.now()}`;
  const scratchUrl = new URL(restoreUrl);
  scratchUrl.pathname = `/${database}`;
  try {
    const { manifest, dumpKey } = await newestManifest(client, bucket, prefix, dir);
    const encrypted = join(dir, "db.dump.age");
    await download(client, bucket, dumpKey, encrypted);
    if ((await sha256(encrypted)) !== manifest.encrypted_sha256) throw new Error("Encrypted checksum mismatch");
    const plain = join(dir, "db.dump");
    await run("age", ["-d", "-i", identity, "-o", plain, encrypted]);
    if ((await sha256(plain)) !== manifest.dump_sha256) throw new Error("Decrypted checksum mismatch");

    await withClient(restoreUrl, (db) => db.query(`create database ${database}`));
    // The dump recreates schema public, so remove the default one first.
    await withClient(scratchUrl.href, (db) => db.query("drop schema public cascade"));
    const { args, env } = connectionParts(scratchUrl.href);
    await run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", ...args], { input: plain, env });

    const [restored, restoredCredits] = await withClient(scratchUrl.href, async (db) => [await tableCounts(db), await creditSum(db)]);
    const mismatches = Object.entries(manifest.table_row_counts)
      .filter(([table, count]) => restored[table] !== count)
      .map(([table, expected]) => ({ table, expected, restored: restored[table] ?? null }));
    const creditsMatch = restoredCredits === manifest.credit_balance_sum;
    const rows = Object.values(restored).reduce((sum, n) => sum + n, 0);
    const ok = mismatches.length === 0 && creditsMatch;
    console.log(JSON.stringify({ ok, backup: manifest.created_at, tables: Object.keys(restored).length, rows, creditsMatch, mismatches }));
    if (!ok) process.exitCode = 1;
  } finally {
    await withClient(restoreUrl, (db) => db.query(`drop database if exists ${database}`)).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const commands = { backup, verify, prune, "restore-test": restoreTest };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`Usage: db-backup.mjs ${Object.keys(commands).join("|")}`);
  process.exit(2);
}
command().catch((error) => {
  console.error(`${process.argv[2]} failed: ${redact(error?.message ?? error)}`);
  process.exit(1);
});
