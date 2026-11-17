# Trimming existing briefs (Phase 1 task 9)

Briefs saved before task 9 carry the whole store snapshot (2–4 MB) in three
places:
- `campaigns.brief_data`;
- `campaign_brief_versions.brief_data`;
- the generation receipt's `response.briefData`.

New briefs store bounded evidence instead (`src/modules/briefs/evidence.ts`).

`scripts/ops/brief-archive.mjs` brings existing rows into line. It works through the rows in batches. For each batch it:

1. Writes the original rows to one archive object in R2. The archive is encrypted to the custodian's public key and checksummed.
2. Downloads the object again, decrypts it with the private key, and checks every row's checksum.
3. Only then replaces each row's snapshot with bounded evidence.
   - Nothing else in a row changes.
   - A row that changed in the meantime is skipped.

Rows of a workspace being deleted are left to the deletion. The tracking tables come from migration 0026.

## Retention

- **Expiry.** Archives expire 30 days after they are written. That is inside Shopify's 30-day deadline for completing a redaction, which covers any shop data an archive holds.
- **Prune daily.** Run `prune --apply` daily while archives exist. After expiry a row can no longer be restored, but it still renders the same from its evidence.

## Keys

The archive key pair is separate from the backup and credential keys.

```bash
node scripts/ops/brief-archive.mjs keygen --out ~/.config/omnitarget/keys/<env>-brief-archive.jwk
```

- **Public key.** The command prints `BRIEF_ARCHIVE_PUBLIC_KEY`, which is public.
- **Private key.** The file (mode 600) goes to the custodian, with a copy in the team's password manager. It is never committed, never stored in R2, and is needed to trim (to verify) and to restore.

## Settings

| Variable | Purpose |
|---|---|
| `BRIEF_ARCHIVE_PUBLIC_KEY` | The custodian's public key, printed by `keygen` |
| `BRIEF_ARCHIVE_R2_BUCKET` | A private bucket. The backup bucket is acceptable: archives are encrypted. |
| `BRIEF_ARCHIVE_PREFIX` | Defaults to `brief-archive/<project ref>` |
| `R2_ENDPOINT` | The R2 account endpoint |
| `BRIEF_ARCHIVE_R2_ACCESS_KEY_ID`, `BRIEF_ARCHIVE_R2_SECRET_ACCESS_KEY` | A token scoped to that bucket with read, write and delete. Never the application's R2 key. |

## Procedure

Every command refuses a database other than `--expect-ref`, and is a dry run without `--apply`.

1. **Measure:**
   ```bash
   DATABASE_URL=… node scripts/ops/brief-archive.mjs status --expect-ref <ref>
   ```
2. **Prove the briefs render the same.**
   1. Restore a fresh backup of the environment into a local Postgres (see `backups.md`).
   2. Run:
      ```bash
      VERIFY_STORED_BRIEFS=1 TEST_DATABASE_URL=postgresql://…@127.0.0.1:…/<restored> pnpm test:db src/modules/briefs
      ```
   3. Every untrimmed campaign and version must render identically once trimmed. That covers the PDF payload and HTML, the copied text, the budget plan and the brief view.
   4. Stop if any differ.
3. **Take and verify a fresh backup** of the environment (`backups.md`).
4. **Dry run:**
   ```bash
   … archive --expect-ref <ref>
   ```
   Check the row count and the bytes saved.
5. **Apply:**
   ```bash
   … archive --expect-ref <ref> --apply --backup-verified --identity-file <private key>
   ```
   Each batch prints its archive once verified.
6. **Confirm:**
   1. Run `status` again: the untrimmed counts should be zero.
   2. Open a few briefs and their PDFs in the app.
7. **Schedule** `prune --apply` daily until the last archive has expired.

## Restoring

```bash
… status --expect-ref <ref>                                   # find the run
… restore --expect-ref <ref> --run <run id>                   # dry run
… restore --expect-ref <ref> --run <run id> --apply --identity-file <private key>
```

- **Exact bytes.** Restore checks the archive's checksums and decrypts it, then writes back the exact original bytes.
- **Changed rows.** A row edited since it was trimmed is left alone and reported.
