# Credential encryption keys

Shopify and Meta credentials are stored encrypted (AES-256-GCM) in
`shop_credentials` and `workspace_meta_credentials` (migration 0020). The key
lives only in the application's environment, never in the database, the
repository or a backup. **A database backup is useless for credentials without
the key that encrypted them**, and a lost key means every shop and Meta
connection must be re-established.

| Variable | Meaning |
|---|---|
| `APP_ENCRYPTION_KEY` | Current key: 32 random bytes, base64 |
| `APP_ENCRYPTION_KEY_VERSION` | Its version, a positive integer (default 1) |
| `APP_ENCRYPTION_PREVIOUS_KEYS` | Older keys kept for decryption only: `1:base64key,2:base64key` |

Every ciphertext records the key version that sealed it.

## Rules

- Each environment has its own key. Staging and production never share one.
- Never commit, print, log, paste into chat or put a real value in `.env.example`.
- Never replace an existing key in place. Rotation adds a new version (below).

## Generating a key (new environment only)

```bash
openssl rand -base64 32
```

Set it as `APP_ENCRYPTION_KEY` with `APP_ENCRYPTION_KEY_VERSION=1` in the
environment's secret store (Vercel project environment variables, scoped to
that environment), and keep a recovery copy as described below.

## Where the staging key is

- `.env.local` on the staging development machine (git-ignored).
- Recovery copy: `~/.config/omnitarget/keys/staging-app-encryption-key-v1`
  (mode 600) on the same machine. Move a copy into the team's password manager
  or secrets vault: a single machine is not a recovery plan.
- Vercel: project `omni-target-6gnl`, Preview environment, branch `staging`.

Production gets its own key at the production release, created and stored the
same way by whoever owns production secrets.

## Recovery

1. Restore the database from its encrypted backup (`backups.md`).
2. Set the same `APP_ENCRYPTION_KEY` / `APP_ENCRYPTION_KEY_VERSION` (and any
   `APP_ENCRYPTION_PREVIOUS_KEYS`) that were current when the backup was taken.
3. Verify: open the app as a connected merchant; credentials decrypt and the
   store syncs. A `CredentialDecryptError` means the key does not match.

If the key is lost, encrypted credentials cannot be recovered: merchants
reconnect Shopify and Meta. Nothing else in the database depends on the key.

## Rotation

1. Generate a new key. Deploy with:
   - `APP_ENCRYPTION_KEY` = new key, `APP_ENCRYPTION_KEY_VERSION` = old version + 1
   - `APP_ENCRYPTION_PREVIOUS_KEYS` = `<old version>:<old key>` (plus any still in use)
2. New and refreshed credentials now use the new key; any credential read is
   re-encrypted under it automatically.
3. Re-encrypt the rest, repeating until `remaining` is 0:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/cron/reseal-credentials
   ```
   Each write applies only over the version it read, so it never overwrites a
   concurrent refresh or reconnection.
4. Confirm nothing is left on the old version:
   `select count(*) from shop_credentials where key_version < <new>` and the same
   for `workspace_meta_credentials`.
5. Remove the old key from `APP_ENCRYPTION_PREVIOUS_KEYS` and redeploy. Keep the
   old key in the vault until every backup taken under it has expired.

If a key is suspected compromised, rotate immediately, then also force
reconnection (Shopify and Meta tokens themselves may be exposed).
