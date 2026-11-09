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

Objects are stored as `<prefix>/<tier>/<YYYY-MM-DD>/omnitarget.dump.age` with a
`.manifest.json` beside each. Retention is 14 days daily, 8 weeks weekly (Sundays,
UTC) and 6 months monthly (the 1st, UTC).

The manifest holds table row counts, the credit total, database size and
checksums. It holds no row data and is not encrypted.

## Credentials

Never use the admin database credentials in GitHub Actions.

**Backup role.** Run once per database as an administrator, with a generated
password that goes straight into a secret store:

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
- A restore-test key, whose private half exists only in the `backup-restore`
  GitHub environment.

## GitHub configuration

Environment `backup-staging`:

- Variables: `BACKUP_R2_BUCKET`, `BACKUP_PREFIX`, `BACKUP_AGE_RECIPIENT`
- Secrets: `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_DATABASE_URL`,
  `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`,
  `BACKUP_R2_READ_ACCESS_KEY_ID`, `BACKUP_R2_READ_SECRET_ACCESS_KEY`

Environment `backup-restore`:

- Variables: `BACKUP_R2_BUCKET`, `BACKUP_PREFIX`
- Secrets: `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_R2_READ_ACCESS_KEY_ID`,
  `BACKUP_R2_READ_SECRET_ACCESS_KEY`, `BACKUP_AGE_RESTORE_IDENTITY`

## Restoring

Before restoring over a real database, confirm with the project owner and record
the project ref you are targeting. Never restore into a project you have not
identified.

1. Choose the backup and download `omnitarget.dump.age` and its manifest:

   ```sh
   aws s3 cp --endpoint-url "https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com" \
     "s3://$BUCKET/$PREFIX/daily/$DATE/omnitarget.dump.age" .
   aws s3 cp --endpoint-url "https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com" \
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

5. Compare `count(*)` per table and `sum(credits_balance)` from
   `user_integrations` with the manifest.

6. Re-apply grants. `--no-privileges` omits them, so run the migrations' grants
   and `scripts/ops/assert-rls-lockdown.mjs` before pointing the application at
   the database.

7. Delete the decrypted dump: `shred -u omnitarget.dump`.

## Limits

- Only schema `public` is backed up. Clerk identities, R2 media and Supabase
  platform settings are outside it.
- Anything written after the last backup is lost.
- Writes made during a restore are not reconciled; stop the application first.
