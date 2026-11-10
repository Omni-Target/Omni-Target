# Database backups and restore (S2.3, DATA-04)

Nightly encrypted `pg_dump` to Cloudflare R2. This is an interim Free-plan
safeguard. It is not point-in-time recovery: a restore loses everything written
since the last successful backup, up to about 24 hours.

Scope today is staging. Production needs its own private bucket, role, tokens
and age keys, and separate approval. Do not retire the production keep-alive
until a production backup has been deployed and verified.

## How it works

`scripts/ops/db-backup.mjs` has four commands:

| Command | What it does | Access needed |
|---|---|---|
| `backup` | Dumps schema `public` in one snapshot, encrypts with age, uploads dump and manifest | Read-only database role, R2 object write |
| `verify` | Reads the newest backup back; checks size, SHA-256 and age header | R2 object read |
| `prune` | Applies retention; the newest backup in each tier is always kept | R2 object write |
| `restore-test` | Decrypts the newest backup into a new throwaway database and compares row counts and the credit total with the manifest | R2 object read, age key, local Postgres |

Objects are stored as
`<prefix>/<tier>/<YYYY-MM-DD>/<UTC timestamp>-<run id>/omnitarget.dump.age` with a
`.manifest.json` beside each. Every run has its own key, and uploads use a
conditional write (`If-None-Match: *`), so an existing object is never
overwritten. Retention is 14 days daily, 8 weeks weekly (Sundays, UTC) and
6 months monthly (the 1st, UTC).

The manifest holds no row data and is not encrypted. It records:

- the backup id, the GitHub run and commit;
- the source project ref, host, database and role;
- migration history: the full id list and the latest id;
- schema counts: tables, functions, indexes, triggers, constraints, foreign keys and RLS tables;
- table row counts, the legacy credit total, and the ledger's balance and entry sums;
- database size, dump duration and SHA-256 of the dump before and after encryption.

`verify` and `restore-test` refuse a backup whose source is not
`BACKUP_EXPECTED_PROJECT_REF`. `restore-test` passes only when the restored
copy has the same rows, migration history, schema counts and ledger sums, and
balances equal the ledger total. `pg_restore --exit-on-error` also fails on any
row that breaks a restored constraint or foreign key.

## Credentials

Never use the admin database credentials in GitHub Actions.

**Backup role.** Staging has `omnitarget_backup`. Its password was last
rotated on 2026-11-10. At that time it could read all 37 tables, write none,
and its sessions were read-only by default. To set the role up on another
database, run this once as an administrator, with a generated password that
goes straight into a secret store:

```sql
create role omnitarget_backup with login password '<generated>'
  bypassrls nosuperuser nocreatedb nocreaterole noinherit;
alter role omnitarget_backup set default_transaction_read_only = on;
grant usage on schema public to omnitarget_backup;
grant select on all tables in schema public to omnitarget_backup;
grant select on all sequences in schema public to omnitarget_backup;
alter default privileges in schema public grant select on tables to omnitarget_backup;
alter default privileges in schema public grant select on sequences to omnitarget_backup;
```

`bypassrls` is required: `pg_dump` fails on tables with row level security
otherwise. Connect through the session pooler as
`omnitarget_backup.<project-ref>` on port 5432, because the direct host is
IPv6-only.

**R2 tokens.** Cloudflare documents no write-only permission. Use two tokens,
each scoped to the backup bucket only:

- Object Read & Write, for `backup` and `prune`.
- Object Read only, for `verify` and `restore-test`.

Because the write token can also read, encryption is what protects the data if
it leaks. Confirm the token can delete objects before relying on `prune`.

**age keys.** Encrypt to two recipients, comma-separated in
`BACKUP_AGE_RECIPIENT`:

- A custodian key, whose private half is held offline and never enters CI.
  For staging this is the existing staging backup key,
  `~/.config/omnitarget/keys/staging-pre-reset-2026-11-09.agekey`, on the
  operator's machine. Copy it into the team's password manager: one machine is
  not a recovery plan.
- A restore-test key, whose private half exists only in the `backup-restore`
  GitHub environment. A lost restore-test key is replaced by generating a new
  pair. The custodian key still decrypts every backup.

The decryption keys are never stored in R2.

## GitHub configuration

Both environments accept deployments only from `main` and `staging`.

Environment `backup-staging`:

- Variables: `BACKUP_R2_BUCKET` (`jsonl-assets`), `BACKUP_PREFIX`
  (`backups/staging-scheduled`), `BACKUP_EXPECTED_PROJECT_REF`
  (`eraycbxedmufsdvhtrvk`), `BACKUP_AGE_RECIPIENT`
- Secrets: `R2_ENDPOINT`, `BACKUP_DATABASE_URL` (the backup role, through the
  session pooler), `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`,
  `BACKUP_R2_READ_ACCESS_KEY_ID`, `BACKUP_R2_READ_SECRET_ACCESS_KEY`

Environment `backup-restore`:

- Variables: `BACKUP_R2_BUCKET`, `BACKUP_PREFIX`, `BACKUP_EXPECTED_PROJECT_REF`
- Secrets: `R2_ENDPOINT`, `BACKUP_R2_READ_ACCESS_KEY_ID`,
  `BACKUP_R2_READ_SECRET_ACCESS_KEY`, `BACKUP_AGE_RESTORE_IDENTITY`

The four `BACKUP_R2_*` key secrets must be API tokens scoped to the backup
bucket, never the application's R2 key: that key also reaches the media bucket.

**Schedule.** GitHub runs schedules only from the default branch, `main`. Every
job checks out `staging`, which holds the script and the pinned lockfile, so
`main` carries only the workflow until the production release. Nightly backup
`17 2 * * *` UTC. Weekly restore test `47 3 * * 0` UTC. Both can also be started
by hand (`workflow_dispatch`, with `restore_test`).

**Failure visibility.** A failed backup, verify, prune or restore test fails
its job. GitHub then notifies the account that last changed the schedule, and a
`report-failure` job opens or comments on a "Scheduled backup failed" issue
naming the run. The issue contains no data.

## Recovery objectives (staging)

| | Target | Basis |
|---|---|---|
| RPO | 24 hours | One nightly backup. Anything written since the last successful backup is lost. Not point-in-time recovery |
| RTO | 1 hour | 2026-11-10 drill: download, decrypt and restore of a 265 KB backup took 4 seconds. The rest of the hour covers finding the key, checks, grants and pointing the application at the database |

These are for staging at its present size. Production needs its own measured
drill and approval.

## Restoring

Before restoring over a real database, confirm with the project owner and record
the project ref you are targeting. Never restore into a project you have not
identified.

1. Choose the backup and download `omnitarget.dump.age` and its manifest:

   ```sh
   aws s3 cp --endpoint-url "$R2_ENDPOINT" \
     "s3://$BUCKET/$PREFIX/daily/$DATE/omnitarget.dump.age" .
   aws s3 cp --endpoint-url "$R2_ENDPOINT" \
     "s3://$BUCKET/$PREFIX/daily/$DATE/omnitarget.manifest.json" .
   ```

2. Check the encrypted file against `encrypted_sha256`:

   ```sh
   sha256sum omnitarget.dump.age
   ```

3. Decrypt on a machine you control with the custodian key, then check the
   result against `dump_sha256`:

   ```sh
   age -d -i custodian.key -o omnitarget.dump omnitarget.dump.age
   sha256sum omnitarget.dump
   ```

4. Restore into a new, empty database first and inspect it. The dump recreates
   schema `public`, so remove the default one:

   ```sh
   psql "$TARGET_URL" -c 'drop schema public cascade'
   pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET_URL" omnitarget.dump
   ```

5. Compare with the manifest: `count(*)` per table, `sum(credits_balance)` from
   `user_integrations`, `schema_migrations`, and the ledger
   (`sum(credit_accounts.balance)` must equal `sum(credit_ledger.quantity)`).
   `db-backup.mjs restore-test` does all of this against a local database.

6. Re-apply grants. `--no-privileges` omits them, so run the migrations' grants
   and `scripts/ops/assert-rls-lockdown.mjs` before pointing the application at
   the database.

7. Delete the decrypted dump: `shred -u omnitarget.dump`.

## Limits

- Only schema `public` is backed up. Clerk identities, R2 media and Supabase
  platform settings are outside it.
- Anything written after the last backup is lost.
- Writes made during a restore are not reconciled; stop the application first.

## Verification record

**2026-11-10, staging, run from the operator's machine with the staging R2 credentials:**
- **Backup:** `20261110T185100Z-local714457`, taken by the backup role through the pooler. Source `eraycbxedmufsdvhtrvk`, 37 tables, migrations through `0021_credit_ledger`, 265,557 bytes encrypted to both recipients.
- **Verify:** the stored size, SHA-256 and age header all match the manifest.
- **Restore test:** into a disposable local Postgres 17, decrypted once with the custodian key and once with the restore-test key. Rows (150), migration history, schema counts (96 functions, 85 indexes, 10 triggers, 154 constraints, 34 foreign keys, 37 RLS tables) and ledger sums all match. Total 3.6 seconds.
- **Overwrite protection:** a second conditional write to an existing key was refused with 412.

The scheduled GitHub run is verified separately, once the bucket-scoped R2 tokens are in place and the workflow is on `main`.
