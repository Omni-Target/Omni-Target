# Production release checklist

Everything the modernisation adds that production needs at the release. Until
then, production is left untouched: these items are configured only when the
release starts. Add to this file whenever implementation introduces something
production will need.

## Environment variables

Staging values come from `.env.local` (and, for the staging deployment, Vercel
Preview scoped to `staging`). Production gets its own value for each, never a
copy of staging's.

| Variable | Introduced | Purpose | Production action |
|---|---|---|---|
| `APP_ENCRYPTION_KEY` | Phase 1 task 4 | AES-256-GCM key for stored Shopify and Meta credentials | Generate a new key (`credential-keys.md`), keep a recovery copy, set as sensitive |
| `APP_ENCRYPTION_KEY_VERSION` | Phase 1 task 4 | Version of the current key | `1` |
| `APP_ENCRYPTION_PREVIOUS_KEYS` | Phase 1 task 4 | Older keys kept for decryption during rotation | Unset at first release |
| `CRON_SECRET` | S1 / Phase 1 task 3 | Authorises the cron routes (`process-deletions`, `reseal-credentials`, …) | Generate; Vercel sends it to scheduled crons |
| `NEXT_PUBLIC_SENTRY_DSN` | S2 | Error reporting | Production DSN of Sentry project `omni-target` |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | S2 | Environment label | `production` (or unset) |
| `SENTRY_AUTH_TOKEN` | S2 | Source-map upload at build | Build-time secret |
| `PAYMENTS_STRIPE_ENABLED` | S2 (SEC-08) | Stripe checkout initiation | Leave unset (off) unless decided otherwise |
| `PAYMENTS_PAYSTACK_ENABLED` | S2 (SEC-08) | Paystack initiation | Leave unset (off) unless decided otherwise |
| `LEGACY_AI_ENDPOINTS_ENABLED` | S0 (SEC-08) | Legacy free AI routes | Leave unset (off) |
| `SHOPIFY_TOKEN_REFRESH_DISABLED` | S1 | Stops token refresh on an environment sharing tokens | Unset in production |
| `SHOPIFY_TEST_BILLING` | S0 (SEC-12) | Allows Shopify test charges to grant credits | Unset in production |
| `LOG_LEVEL` | Phase 1 task 1 | Structured logger level | Unset (`info`) |
| `DATABASE_QUOTA_MB` | Phase 1 task 10 | Database quota for capacity alerts (60% / 75%) and the import pre-flight check | The production plan's database size in MB, e.g. `8192` on Pro (`architecture/capacity-measurements.md`) |
| `BRIEF_ARCHIVE_PUBLIC_KEY` | Phase 1 task 9 | Encrypts archived briefs (ops tool only, not the app) | Generate a production key pair with `brief-archive.mjs keygen`; the private key goes to the custodian (`brief-archive.md`) |
| `BRIEF_ARCHIVE_R2_BUCKET`, `BRIEF_ARCHIVE_PREFIX` | Phase 1 task 9 | Where archived briefs go (ops tool only) | The production backup bucket, prefix `brief-archive/<production ref>` |
| `BRIEF_ARCHIVE_R2_ACCESS_KEY_ID`, `BRIEF_ARCHIVE_R2_SECRET_ACCESS_KEY` | Phase 1 task 9 | R2 token for the archive (ops tool only) | A token scoped to that bucket, with read, write and delete |

## Database

- Apply migrations from production's current state through the latest
  (0012 RLS lockdown and 0013 onward, 0018 workspaces, 0019 leases,
  0020 credentials, 0021 credit ledger, and later ones), after a verified
  production backup.
- Run the legacy migration (task 6) as a dry run first, review the report,
  then apply it. It gives each legacy account its own workspace, opens its
  credit balance, records its purchases and attributes its history:
  `DATABASE_URL=… node scripts/ops/legacy-migration.mjs --expect-ref <production ref>`
  (dry run), then the same with `--apply`. Review `credit_opening_reviews`,
  contested or unresolved `legacy_shop_claims`, and `legacy_orphans`.
- Plaintext credential columns are cleared only after a verified backup and
  restore: `--apply --clear-plaintext --backup-verified`.
- Trim existing briefs to bounded evidence (task 9, `brief-archive.md`):
  1. Restore a fresh production backup locally, and prove every brief renders identically once trimmed (`VERIFY_STORED_BRIEFS=1 … pnpm test:db src/modules/briefs`).
  2. Take and verify a new backup.
  3. Run `brief-archive.mjs archive` as a dry run.
  4. Run it with `--apply --backup-verified --identity-file …`.
  5. Run `prune --apply` daily until the archives expire (30 days).

## Platform

- Supabase plan: the capacity measurements (task 10, `architecture/capacity-measurements.md`) recommend production starts on Pro. The upgrade needs its own approval. Set `DATABASE_QUOTA_MB` to the chosen plan's size.
- Capacity snapshots: `/api/cron/capacity` runs daily from `vercel.json` once production deploys; confirm the first snapshot and that Sentry receives its alerts.

- Vercel production: production variables above, crons from `vercel.json`, and
  the production domain. Preview builds stay off (`deployments.md`).
- Shopify app: compliance webhook URLs and scopes in `shopify.app.toml` point to
  production.
- Backups: production needs its own bucket, backup role, R2 tokens, age keys
  and schedule (`backups.md`).
