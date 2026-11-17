/**
 * Real Postgres tests for the brief evidence archive (Phase 1, task 9):
 * migration 0026 and scripts/ops/brief-archive.mjs, with a local directory
 * standing in for R2. Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  archiveBriefs, decryptFile, dirStore, encryptFile, generateKeyPair, pruneArchives, restoreRun,
} from "../../scripts/ops/brief-archive.mjs";
import { trimStoredBrief } from "../../src/modules/briefs/evidence.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 4 });
const client = new pg.Client({ connectionString: url });
await client.connect();
const work = mkdtempSync(join(tmpdir(), "brief-archive-test-"));
afterAll(async () => {
  await client.end();
  await pool.end();
  rmSync(work, { recursive: true, force: true });
});
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

const keys = generateKeyPair();
const store = dirStore(join(work, "store"));
const archive = (options = {}) =>
  archiveBriefs({ client, store, publicKey: keys.publicKey, identity: keys.identity, prefix: "brief-archive/test", apply: true, batch: 1000, ...options });

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A brief as generation stored it before task 9: the whole store snapshot under storeInsights. */
function fullBrief(productName) {
  return {
    schemaVersion: 2, productName, generatedAt: "2026-11-01T00:00:00.000Z", aiInsights: { warnings: [] }, selectedDuration: 14,
    storeInsights: {
      store: { name: "Shop", domain: "shop.example", myshopify_domain: "shop.myshopify.com", currency: "GBP", country: "GB" },
      orders: { order_count: 900, orders_last_30_days: 80, average_order_value: 41.5, peak_days: ["Friday"], top_locations: [{ city: "Leeds", country: "GB", percentage: 40 }], peak_hours: [20] },
      products: Array.from({ length: 300 }, (_, i) => ({ id: i, name: i === 3 ? productName : `Other ${i}`, handle: `h-${i}`, price: 10 + i, in_stock: i % 7 !== 0, description: "x".repeat(400), tags: ["a", "b"] })),
      prespend: { analytics: { window_days: 30, conversion_rate: 0.02, recent_funnel: { window_days: 30, sessions: 900 } }, markets: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}` })) },
      data_quality: { warnings: ["w"], anonymous_orders: 3 },
    },
  };
}

/** One saved brief of each kind: campaign, version and receipt. */
async function savedBrief({ workspace = null } = {}) {
  const user = `user_archive_${tag()}`;
  const product = `Lamp ${tag()}`;
  const brief = fullBrief(product);
  const campaign = (await one("insert into public.campaigns (clerk_user_id, workspace_id, product_name, brief_data) values ($1, $2, $3, $4) returning id", [user, workspace, product, brief])).id;
  const version = (await one("insert into public.campaign_brief_versions (campaign_id, clerk_user_id, attempt_number, brief_data) values ($1, $2, 1, $3) returning id", [campaign, user, brief])).id;
  const request = randomUUID();
  await q("insert into public.brief_generation_receipts (clerk_user_id, request_id, request_hash, response) values ($1, $2, 'h', $3)",
    [user, request, { campaignId: campaign, headline: "Hi", briefData: brief }]);
  return { user, product, campaign, version, request };
}

const rowsOf = async (b) => ({
  campaign: (await one("select brief_data::text as v from public.campaigns where id = $1", [b.campaign])).v,
  version: (await one("select brief_data::text as v from public.campaign_brief_versions where id = $1", [b.version])).v,
  receipt: (await one("select response::text as v from public.brief_generation_receipts where request_id = $1", [b.request])).v,
});
const archiveFiles = () => { try { return readdirSync(join(work, "store"), { recursive: true }).filter((f) => String(f).endsWith(".enc")); } catch { return []; } };

describe("brief archive", () => {
  it("archives, verifies and trims every saved brief, then restores the originals byte for byte", async () => {
    const b = await savedBrief();
    const before = await rowsOf(b);

    const report = await archive();
    expect(report.trimmed).toBeGreaterThanOrEqual(3);
    const after = await rowsOf(b);

    // Only the snapshot changed, into exactly the evidence new briefs store.
    expect(JSON.parse(after.campaign)).toEqual(trimStoredBrief("brief", JSON.parse(before.campaign), b.product));
    expect(JSON.parse(after.version)).toEqual(trimStoredBrief("brief", JSON.parse(before.version), b.product));
    expect(JSON.parse(after.receipt)).toEqual(trimStoredBrief("receipt", JSON.parse(before.receipt), b.product));
    expect(after.campaign.length).toBeLessThan(before.campaign.length / 20);
    expect(JSON.parse(after.campaign).storeInsights.products.map((p) => p.name)).toEqual([b.product]);

    const entry = await one("select r.id as run, r.verified_at, e.trimmed_at from public.brief_archive_entries e join public.brief_archive_runs r on r.id = e.run_id where e.table_name = 'campaigns' and e.row_key = $1", [b.campaign]);
    expect(entry.verified_at).not.toBeNull();
    expect(entry.trimmed_at).not.toBeNull();

    // Trimming again finds nothing new for these rows.
    await archive();
    expect(await rowsOf(b)).toEqual(after);

    const restored = await restoreRun({ client, store, identity: keys.identity, runId: entry.run, apply: true });
    expect(restored.skipped_changed).toBe(0);
    expect(await rowsOf(b)).toEqual(before);
  });

  it("changes nothing on a dry run", async () => {
    const b = await savedBrief();
    const before = await rowsOf(b);
    const files = archiveFiles().length;
    const report = await archive({ apply: false });
    expect(report.mode).toBe("dry-run");
    expect(report.rows).toBeGreaterThanOrEqual(3);
    expect(report.evidence_bytes).toBeLessThan(report.snapshot_bytes);
    expect(await rowsOf(b)).toEqual(before);
    expect(archiveFiles().length).toBe(files);
    await archive();
  });

  it("refuses to trim when the stored archive does not match, or the key cannot decrypt it", async () => {
    const tampering = { ...store, async get(key, file) { await store.get(key, file); const bytes = readFileSync(file); bytes[bytes.length - 40] ^= 1; writeFileSync(file, bytes); } };
    const b = await savedBrief();
    const before = await rowsOf(b);
    await expect(archive({ store: tampering })).rejects.toThrow("archive_checksum_mismatch");
    expect(await rowsOf(b)).toEqual(before);
    expect((await one("select count(*)::int as n from public.brief_archive_entries where row_key = $1 and trimmed_at is not null", [b.campaign])).n).toBe(0);

    const other = generateKeyPair();
    await expect(archive({ identity: other.identity })).rejects.toThrow("archive_key_mismatch");
    expect(await rowsOf(b)).toEqual(before);
    await archive();
  });

  it("skips a row that changed after it was archived, keeping the newer content", async () => {
    const b = await savedBrief();
    const racing = { ...store, async put(key, file) {
      await store.put(key, file);
      await q("update public.campaigns set brief_data = jsonb_set(brief_data, '{selectedDuration}', '7') where id = $1", [b.campaign]);
    } };
    const report = await archive({ store: racing });
    expect(report.skipped_changed).toBeGreaterThanOrEqual(1);
    const campaign = JSON.parse((await rowsOf(b)).campaign);
    expect(campaign.selectedDuration).toBe(7);
    expect(campaign.storeInsights.evidence_version).toBeUndefined();
    await archive();
    expect(JSON.parse((await rowsOf(b)).campaign).storeInsights.evidence_version).toBe(1);
  });

  it("leaves the briefs of a workspace being deleted to the deletion", async () => {
    const ws = (await one("insert into public.workspaces (owner_clerk_user_id, status) values ($1, 'deletion_processing') returning id", [`user_archive_${tag()}`])).id;
    const b = await savedBrief({ workspace: ws });
    const before = await rowsOf(b);
    await archive();
    expect(await rowsOf(b)).toEqual(before);
  });

  it("deletes archives once they expire, after which they cannot be restored", async () => {
    await savedBrief();
    const { runs } = await archive();
    const run = runs.at(-1).run_id;
    const objects = archiveFiles().length;
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect((await pruneArchives({ client, store, now: later })).mode).toBe("dry-run");
    const pruned = await pruneArchives({ client, store, apply: true, now: later });
    expect(pruned.deleted).toBeGreaterThanOrEqual(1);
    expect(archiveFiles().length).toBeLessThan(objects);
    await expect(restoreRun({ client, store, identity: keys.identity, runId: run, apply: true })).rejects.toThrow("archive_expired");
    expect((await one("select count(*)::int as n from public.brief_archive_runs where expired_at is null and expires_at <= $1", [later])).n).toBe(0);
  });

  it("keeps the tracking tables owner-only", async () => {
    for (const table of ["brief_archive_runs", "brief_archive_entries"]) {
      expect(await one(
        `select c.relrowsecurity as rls, has_table_privilege('service_role', c.oid, 'select') as service,
                has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select') as public_read
           from pg_class c where c.oid = $1::regclass`, [`public.${table}`])).toEqual({ rls: true, service: false, public_read: false });
    }
  });
});

describe("archive encryption", () => {
  it("round-trips, and fails on any altered byte or another key without leaving output", async () => {
    const plain = join(work, "plain.txt");
    writeFileSync(plain, "line one\nline two\n".repeat(1000));
    const enc = join(work, "plain.enc");
    await encryptFile(plain, enc, keys.publicKey);
    expect(statSync(enc).mode & 0o077).toBe(0);
    const out = join(work, "plain.out");
    await decryptFile(enc, out, keys.identity);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(plain, "utf8"));

    for (const offset of [9, 20, 70, -3]) {
      const bytes = readFileSync(enc);
      bytes[offset < 0 ? bytes.length + offset : offset] ^= 1;
      const bad = join(work, `bad${offset}.enc`);
      writeFileSync(bad, bytes);
      const badOut = join(work, `bad${offset}.out`);
      await expect(decryptFile(bad, badOut, keys.identity)).rejects.toThrow(/archive_/);
      expect(() => statSync(badOut)).toThrow();
    }
    await expect(decryptFile(enc, join(work, "other.out"), generateKeyPair().identity)).rejects.toThrow("archive_key_mismatch");
  });
});
