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

## Platform

- Vercel production: production variables above, crons from `vercel.json`, and
  the production domain. Preview builds stay off (`deployments.md`).
- Shopify app: compliance webhook URLs and scopes in `shopify.app.toml` point to
  production.
- Backups: production needs its own bucket, backup role, R2 tokens, age keys
  and schedule (`backups.md`).
