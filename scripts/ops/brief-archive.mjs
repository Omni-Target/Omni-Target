/**
 * Brief evidence archive (Phase 1, task 9; migration 0026).
 *
 * Existing briefs carry the whole store snapshot under storeInsights (in
 * campaigns.brief_data, campaign_brief_versions.brief_data and the receipt's
 * response.briefData). This tool archives each original row, encrypted and
 * checksummed, verifies the archive by downloading and decrypting it, and only
 * then replaces that snapshot with the bounded evidence new briefs store
 * (src/modules/briefs/evidence.ts). Nothing else in a row changes.
 *
 *   node scripts/ops/brief-archive.mjs status   --expect-ref <ref>
 *   node scripts/ops/brief-archive.mjs archive  --expect-ref <ref> [--apply --backup-verified --identity-file <f>] [--batch 25]
 *   node scripts/ops/brief-archive.mjs restore  --expect-ref <ref> --run <id> [--apply --identity-file <f>]
 *   node scripts/ops/brief-archive.mjs prune    --expect-ref <ref> [--apply]
 *   node scripts/ops/brief-archive.mjs keygen   --out <identity file>
 *
 * Every command except keygen is a dry run unless --apply is given. Trimming
 * needs --backup-verified (a database backup taken and verified first, see
 * runbooks/backups.md) and the private key, so the archive is proven to
 * decrypt before any row changes. Archives expire after 30 days, inside
 * Shopify's 30-day redaction deadline; `prune` deletes them.
 *
 * Database: DATABASE_URL (or SUPABASE_DB_URL), refused unless its project ref
 * is --expect-ref ("local" for 127.0.0.1/localhost).
 * Storage: --store-dir <dir> for a local directory, or R2 with R2_ENDPOINT,
 * BRIEF_ARCHIVE_R2_BUCKET, BRIEF_ARCHIVE_R2_ACCESS_KEY_ID and
 * BRIEF_ARCHIVE_R2_SECRET_ACCESS_KEY (a token scoped to that bucket), under
 * BRIEF_ARCHIVE_PREFIX (default brief-archive/<ref>).
 * Encryption: BRIEF_ARCHIVE_PUBLIC_KEY (from keygen). The private key stays
 * with its custodian and is passed only as --identity-file.
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, randomUUID,
} from "node:crypto";
import {
  appendFileSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import pg from "pg";
import { trimStoredBrief } from "../../src/modules/briefs/evidence.ts";

export const RETENTION_DAYS = 30;
const MAGIC = Buffer.from("OTBRIEF1");
const HEADER_BYTES = MAGIC.length + 8 + 32 + 12;
const TAG_BYTES = 16;
const INFO = Buffer.from("omnitarget brief archive v1");

// ── Encryption: X25519 key agreement, HKDF-SHA256, AES-256-GCM ──────────────

const raw = (b64u) => Buffer.from(b64u, "base64url");
export const keyId = (publicKey) => createHash("sha256").update(raw(publicKey)).digest("hex").slice(0, 16);

/** A new key pair: the public key (base64url) for BRIEF_ARCHIVE_PUBLIC_KEY, the private JWK for the custodian. */
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: publicKey.export({ format: "jwk" }).x, identity: privateKey.export({ format: "jwk" }) };
}

function contentKey(shared, ephemeralRaw, recipientRaw) {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, recipientRaw]), INFO, 32));
}

/** Encrypts gzip(plaintext) to one recipient. Layout: magic, key id, ephemeral key, nonce, ciphertext, tag. */
export async function encryptFile(plainPath, outPath, publicKey) {
  const recipientRaw = raw(publicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = raw(ephemeral.publicKey.export({ format: "jwk" }).x);
  const recipient = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKey }, format: "jwk" });
  const key = contentKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), ephemeralRaw, recipientRaw);
  const nonce = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from(keyId(publicKey), "hex"), ephemeralRaw, nonce]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  writeFileSync(outPath, header, { mode: 0o600 });
  await pipeline(createReadStream(plainPath), createGzip(), cipher, createWriteStream(outPath, { flags: "a" }));
  appendFileSync(outPath, cipher.getAuthTag());
}

/** Decrypts and authenticates an archive; a wrong key or any altered byte fails and leaves no output. */
export async function decryptFile(encPath, outPath, identity) {
  const size = statSync(encPath).size;
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error("archive_truncated");
  const fd = openSync(encPath, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  readSync(fd, header, 0, HEADER_BYTES, 0);
  readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  closeSync(fd);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("archive_format_unknown");
  if (header.subarray(MAGIC.length, MAGIC.length + 8).toString("hex") !== keyId(identity.x)) throw new Error("archive_key_mismatch");
  const ephemeralRaw = header.subarray(MAGIC.length + 8, MAGIC.length + 40);
  const nonce = header.subarray(MAGIC.length + 40);
  const ephemeral = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: ephemeralRaw.toString("base64url") }, format: "jwk" });
  const key = contentKey(diffieHellman({ privateKey: createPrivateKey({ key: identity, format: "jwk" }), publicKey: ephemeral }), ephemeralRaw, raw(identity.x));
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(encPath, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }), decipher, createGunzip(), createWriteStream(outPath, { mode: 0o600 }));
  } catch (error) {
    rmSync(outPath, { force: true });
    throw new Error(`archive_authentication_failed: ${error.message}`);
  }
}

export function readIdentity(path) {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("identity_file_must_be_private (chmod 600)");
  return JSON.parse(readFileSync(path, "utf8"));
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// ── Storage ─────────────────────────────────────────────────────────────────

/** A local directory, for tests and rehearsals. */
export function dirStore(root) {
  const at = (key) => join(root, key);
  return {
    async put(key, file) { mkdirSync(dirname(at(key)), { recursive: true }); copyFileSync(file, at(key)); },
    async get(key, file) { copyFileSync(at(key), file); },
    async remove(key) { if (existsSync(at(key))) unlinkSync(at(key)); },
  };
}

async function r2Store({ endpoint, bucket, accessKeyId, secretAccessKey }) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("R2 settings are incomplete");
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
  return {
    async put(key, file) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: statSync(file).size }));
    },
    async get(key, file) {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(Body, createWriteStream(file, { mode: 0o600 }));
    },
    async remove(key) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}

// ── Rows ────────────────────────────────────────────────────────────────────

const LIVE = "coalesce(w.status, 'active') in ('active', 'disconnected')";
const UNBOUNDED = (path) => `jsonb_typeof(${path}) = 'object' and not (${path} ? 'evidence_version')`;
const digest = (column) => `encode(sha256(convert_to(${column}::text, 'UTF8')), 'hex')`;

/** Where each kind of saved brief lives. Rows of a workspace being deleted are left to the deletion. */
export const SOURCES = [
  {
    table: "campaigns", kind: "brief", column: "brief_data", key: "id", path: "{storeInsights}",
    select: `select c.id::text as key, c.brief_data::text as value, c.product_name as product
               from public.campaigns c left join public.workspaces w on w.id = c.workspace_id
              where ${UNBOUNDED("c.brief_data -> 'storeInsights'")} and ${LIVE} and c.id > $2::uuid order by c.id limit $1`,
  },
  {
    table: "campaign_brief_versions", kind: "brief", column: "brief_data", key: "id", path: "{storeInsights}",
    select: `select v.id::text as key, v.brief_data::text as value, c.product_name as product
               from public.campaign_brief_versions v join public.campaigns c on c.id = v.campaign_id
               left join public.workspaces w on w.id = coalesce(v.workspace_id, c.workspace_id)
              where ${UNBOUNDED("v.brief_data -> 'storeInsights'")} and ${LIVE} and v.id > $2::uuid order by v.id limit $1`,
  },
  {
    table: "brief_generation_receipts", kind: "receipt", column: "response", key: "request_id", path: "{briefData,storeInsights}",
    select: `select r.request_id::text as key, r.response::text as value, c.product_name as product
               from public.brief_generation_receipts r
               left join public.campaigns c on c.id::text = r.response ->> 'campaignId'
               left join public.workspaces w on w.id = coalesce(r.workspace_id, c.workspace_id)
              where ${UNBOUNDED("r.response -> 'briefData' -> 'storeInsights'")} and ${LIVE} and r.request_id > $2::uuid order by r.request_id limit $1`,
  },
];
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const freshCursors = () => Object.fromEntries(SOURCES.map((s) => [s.table, ZERO_UUID]));

/** The row's current snapshot and the bounded evidence that replaces it. */
function trimFor(source, value, product) {
  const parsed = JSON.parse(value);
  const brief = source.kind === "brief" ? parsed : parsed.briefData;
  const trimmed = trimStoredBrief(source.kind, parsed, product);
  const evidence = source.kind === "brief" ? trimmed.storeInsights : trimmed.briefData.storeInsights;
  return { snapshotBytes: Buffer.byteLength(JSON.stringify(brief.storeInsights)), evidence };
}

/** The next untrimmed rows, at most `limit`, after the cursors (one per table). */
async function nextRows(client, cursors, limit) {
  const rows = [];
  for (const source of SOURCES) {
    if (rows.length >= limit) break;
    const found = (await client.query(source.select, [limit - rows.length, cursors[source.table]])).rows;
    for (const row of found) {
      rows.push({ source, ...row, sha256: sha256(row.value), bytes: Buffer.byteLength(row.value), ...trimFor(source, row.value, row.product) });
      cursors[source.table] = row.key;
    }
  }
  return rows;
}

export async function briefArchiveStatus(client) {
  const untrimmed = Object.fromEntries(SOURCES.map((s) => [s.table, { rows: 0, snapshot_bytes: 0, evidence_bytes: 0 }]));
  const cursors = freshCursors();
  for (;;) {
    const rows = await nextRows(client, cursors, 50);
    if (rows.length === 0) break;
    for (const row of rows) {
      const totals = untrimmed[row.source.table];
      totals.rows += 1;
      totals.snapshot_bytes += row.snapshotBytes;
      totals.evidence_bytes += Buffer.byteLength(JSON.stringify(row.evidence));
    }
  }
  const runs = (await client.query(
    `select r.id, r.object_key, r.rows_archived, r.created_at, r.verified_at, r.expires_at, r.expired_at,
            count(e.*) filter (where e.trimmed_at is not null and e.restored_at is null)::int as trimmed,
            count(e.*) filter (where e.restored_at is not null)::int as restored
       from public.brief_archive_runs r left join public.brief_archive_entries e on e.run_id = r.id
      group by r.id order by r.created_at`)).rows;
  return { untrimmed, runs };
}

/**
 * Archives and trims every untrimmed brief, one archive per batch. A dry run
 * reports what would be archived and changes nothing.
 */
export async function archiveBriefs({ client, store, publicKey, identity, prefix, apply = false, batch = 25, retentionDays = RETENTION_DAYS, log = () => {} }) {
  if (retentionDays < 1 || retentionDays > RETENTION_DAYS) throw new Error(`retention_days_must_be_1_to_${RETENTION_DAYS}`);
  const cursors = freshCursors();
  const report = { mode: apply ? "apply" : "dry-run", runs: [], rows: 0, trimmed: 0, skipped_changed: 0, snapshot_bytes: 0, evidence_bytes: 0 };
  for (;;) {
    const rows = await nextRows(client, cursors, batch);
    if (rows.length === 0) break;
    for (const row of rows) {
      report.rows += 1;
      report.snapshot_bytes += row.snapshotBytes;
      report.evidence_bytes += Buffer.byteLength(JSON.stringify(row.evidence));
    }
    if (apply) report.runs.push(await archiveBatch({ client, store, publicKey, identity, prefix, rows, retentionDays, report, log }));
  }
  return report;
}

async function archiveBatch({ client, store, publicKey, identity, prefix, rows, retentionDays, report, log }) {
  const work = mkdtempSync(join(tmpdir(), "brief-archive-"));
  try {
    const runId = randomUUID();
    const plain = join(work, "archive.jsonl");
    writeFileSync(plain, rows.map((r) => JSON.stringify({ table: r.source.table, key: r.key, sha256: r.sha256, value: r.value })).join("\n") + "\n", { mode: 0o600 });
    const plaintextSha = await sha256File(plain);
    const enc = join(work, "archive.enc");
    await encryptFile(plain, enc, publicKey);
    const ciphertextSha = await sha256File(enc);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + retentionDays * 86_400_000);
    const objectKey = `${prefix}/${createdAt.toISOString().slice(0, 10)}/${runId}.jsonl.gz.enc`;
    await store.put(objectKey, enc);
    const manifest = join(work, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ run_id: runId, key_id: keyId(publicKey), rows: rows.length, plaintext_sha256: plaintextSha, ciphertext_sha256: ciphertextSha, created_at: createdAt, expires_at: expiresAt }, null, 2));
    await store.put(objectKey.replace(/\.jsonl\.gz\.enc$/, ".manifest.json"), manifest);

    await client.query("begin");
    await client.query(
      `insert into public.brief_archive_runs (id, object_key, key_id, plaintext_sha256, ciphertext_sha256, rows_archived, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`, [runId, objectKey, keyId(publicKey), plaintextSha, ciphertextSha, rows.length, createdAt, expiresAt]);
    for (const r of rows) {
      await client.query("insert into public.brief_archive_entries (run_id, table_name, row_key, original_sha256, original_bytes) values ($1, $2, $3, $4, $5)",
        [runId, r.source.table, r.key, r.sha256, r.bytes]);
    }
    await client.query("commit");

    // Proven before anything is trimmed: the stored object decrypts to exactly these rows.
    await verifyArchive({ store, objectKey, ciphertextSha, plaintextSha, identity, work, expected: rows.map((r) => [`${r.source.table}:${r.key}`, r.sha256]) });
    await client.query("update public.brief_archive_runs set verified_at = now() where id = $1", [runId]);
    log(`archive ${objectKey}: ${rows.length} rows verified`);

    let trimmed = 0;
    for (const r of rows) {
      await client.query("begin");
      const updated = (await client.query(
        `update public.${r.source.table} set ${r.source.column} = jsonb_set(${r.source.column}, $3::text[], $4::jsonb)
          where ${r.source.key} = $1::uuid and ${digest(r.source.column)} = $2
          returning ${digest(r.source.column)} as sha, octet_length(${r.source.column}::text) as bytes`,
        [r.key, r.sha256, r.source.path, JSON.stringify(r.evidence)])).rows;
      if (updated.length !== 1) {
        await client.query("rollback");
        report.skipped_changed += 1;
        continue;
      }
      await client.query(
        "update public.brief_archive_entries set trimmed_sha256 = $4, trimmed_bytes = $5, trimmed_at = now() where run_id = $1 and table_name = $2 and row_key = $3",
        [runId, r.source.table, r.key, updated[0].sha, updated[0].bytes]);
      await client.query("commit");
      trimmed += 1;
    }
    report.trimmed += trimmed;
    return { run_id: runId, object_key: objectKey, rows: rows.length, trimmed };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Downloads, checksums and decrypts an archive; returns its rows by "table:key". */
async function verifyArchive({ store, objectKey, ciphertextSha, plaintextSha, identity, work, expected }) {
  const enc = join(work, "check.enc");
  const plain = join(work, "check.jsonl");
  await store.get(objectKey, enc);
  if ((await sha256File(enc)) !== ciphertextSha) throw new Error("archive_checksum_mismatch");
  await decryptFile(enc, plain, identity);
  if ((await sha256File(plain)) !== plaintextSha) throw new Error("archive_plaintext_mismatch");
  const rows = new Map();
  for await (const line of createInterface({ input: createReadStream(plain), crlfDelay: Infinity })) {
    if (!line) continue;
    const entry = JSON.parse(line);
    if (sha256(entry.value) !== entry.sha256) throw new Error("archive_row_checksum_mismatch");
    rows.set(`${entry.table}:${entry.key}`, entry);
  }
  if (expected) {
    if (rows.size !== expected.length) throw new Error("archive_row_count_mismatch");
    for (const [id, sha] of expected) if (rows.get(id)?.sha256 !== sha) throw new Error("archive_row_missing");
  }
  return rows;
}

/** Puts every trimmed row of one run back exactly as archived. A row changed since trimming is left alone. */
export async function restoreRun({ client, store, identity, runId, apply = false }) {
  const run = (await client.query("select * from public.brief_archive_runs where id = $1", [runId])).rows[0];
  if (!run) throw new Error("archive_run_not_found");
  if (run.expired_at) throw new Error("archive_expired");
  const entries = (await client.query(
    "select * from public.brief_archive_entries where run_id = $1 and trimmed_at is not null and restored_at is null", [runId])).rows;
  const report = { mode: apply ? "apply" : "dry-run", run_id: runId, rows: entries.length, restored: 0, skipped_changed: 0 };
  if (!apply || entries.length === 0) return report;
  const work = mkdtempSync(join(tmpdir(), "brief-restore-"));
  try {
    const archived = await verifyArchive({ store, objectKey: run.object_key, ciphertextSha: run.ciphertext_sha256, plaintextSha: run.plaintext_sha256, identity, work });
    for (const entry of entries) {
      const source = SOURCES.find((s) => s.table === entry.table_name);
      const original = archived.get(`${entry.table_name}:${entry.row_key}`);
      if (!original || original.sha256 !== entry.original_sha256) throw new Error("archive_row_missing");
      await client.query("begin");
      const updated = (await client.query(
        `update public.${source.table} set ${source.column} = $3::jsonb where ${source.key} = $1::uuid and ${digest(source.column)} = $2
         returning ${digest(source.column)} as sha`, [entry.row_key, entry.trimmed_sha256, original.value])).rows;
      if (updated.length !== 1 || updated[0].sha !== entry.original_sha256) {
        await client.query("rollback");
        report.skipped_changed += 1;
        continue;
      }
      await client.query("update public.brief_archive_entries set restored_at = now() where run_id = $1 and table_name = $2 and row_key = $3",
        [runId, entry.table_name, entry.row_key]);
      await client.query("commit");
      report.restored += 1;
    }
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Deletes archives past their expiry; their rows can then no longer be restored. */
export async function pruneArchives({ client, store, apply = false, now = new Date() }) {
  const due = (await client.query("select id, object_key from public.brief_archive_runs where expired_at is null and expires_at <= $1 order by expires_at", [now])).rows;
  const report = { mode: apply ? "apply" : "dry-run", due: due.length, deleted: 0 };
  if (!apply) return report;
  for (const run of due) {
    await store.remove(run.object_key);
    await store.remove(run.object_key.replace(/\.jsonl\.gz\.enc$/, ".manifest.json"));
    await client.query("update public.brief_archive_runs set expired_at = now() where id = $1", [run.id]);
    report.deleted += 1;
  }
  return report;
}

// ── Command line ─────────────────────────────────────────────────────────────

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const fail = (message) => { console.error(message); process.exit(2); };

  if (command === "keygen") {
    const out = value("--out");
    if (!out || existsSync(out)) fail("Usage: brief-archive.mjs keygen --out <new identity file> (the file must not exist)");
    const { publicKey, identity } = generateKeyPair();
    writeFileSync(out, JSON.stringify(identity), { mode: 0o600 });
    console.log(`Private key written to ${out} (mode 600). Give it to its custodian; never commit it.`);
    console.log(`BRIEF_ARCHIVE_PUBLIC_KEY=${publicKey}`);
    return;
  }
  if (!["status", "archive", "restore", "prune"].includes(command)) fail("Usage: brief-archive.mjs <status|archive|restore|prune|keygen> --expect-ref <ref> [...]");

  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  const expectRef = value("--expect-ref");
  if (!url || !expectRef) fail("DATABASE_URL and --expect-ref are required.");
  const parsed = new URL(url);
  const local = ["127.0.0.1", "localhost"].includes(parsed.hostname);
  const user = decodeURIComponent(parsed.username);
  const ref = local ? "local" : user.includes(".") ? user.split(".").pop() : parsed.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] ?? null;
  if (ref !== expectRef) fail(`Refusing: the database is project "${ref}", not "${expectRef}".`);

  const apply = flag("--apply");
  if (command === "archive" && apply && !flag("--backup-verified")) fail("Refusing: trimming needs a verified database backup first (--backup-verified).");
  const identityFile = value("--identity-file");
  if (apply && (command === "archive" || command === "restore") && !identityFile) fail("Refusing: --apply needs --identity-file, so the archive is proven to decrypt.");
  let identity = null;
  if (identityFile) {
    try { identity = readIdentity(identityFile); } catch (error) { fail(`Refusing: ${error.message}`); }
  }
  const publicKey = process.env.BRIEF_ARCHIVE_PUBLIC_KEY;
  if (command === "archive" && apply) {
    if (!publicKey) fail("BRIEF_ARCHIVE_PUBLIC_KEY is required.");
    if (keyId(publicKey) !== keyId(identity.x)) fail("Refusing: --identity-file does not match BRIEF_ARCHIVE_PUBLIC_KEY.");
  }

  const storeDir = value("--store-dir");
  // Dry runs and status never touch storage.
  const store = !apply
    ? null
    : storeDir
      ? dirStore(storeDir)
      : await r2Store({
          endpoint: process.env.R2_ENDPOINT, bucket: process.env.BRIEF_ARCHIVE_R2_BUCKET,
          accessKeyId: process.env.BRIEF_ARCHIVE_R2_ACCESS_KEY_ID, secretAccessKey: process.env.BRIEF_ARCHIVE_R2_SECRET_ACCESS_KEY,
        });
  const prefix = process.env.BRIEF_ARCHIVE_PREFIX || `brief-archive/${ref}`;

  const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    let report;
    if (command === "status") report = await briefArchiveStatus(client);
    if (command === "archive") report = await archiveBriefs({ client, store, publicKey, identity, prefix, apply, batch: Number(value("--batch") ?? 25), log: console.log });
    if (command === "restore") report = await restoreRun({ client, store, identity, runId: value("--run"), apply });
    if (command === "prune") report = await pruneArchives({ client, store, apply });
    console.log(JSON.stringify({ project: ref, command, ...report }, null, 2));
  } catch (error) {
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
