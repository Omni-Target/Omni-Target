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
| `REDACTION_SUPPRESSION_KEY` | Phase 2 task 2 | Keys the digests that stop redacted customers and orders from being stored again (migration 0031) | Generate 32 random bytes, base64-encoded, and set it as sensitive in Vercel production and Trigger.dev Production. Keep a recovery copy with the key custodian. Never replace it without keeping the old key: digests made under a lost key can't be matched, and redacted data could return |
| `TRIGGER_SECRET_KEY` | Phase 2 task 3 | Lets the app trigger Trigger.dev tasks. Locally it is the Development key (`tr_dev_…`) in `.env.local` | The Trigger.dev project's Production secret key (`tr_prod_…`), set in Vercel production only |
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

- Supabase plan: Pro is the intended production starting plan (ADR 0002, decision 6; measurements in `architecture/capacity-measurements.md`). Approve the upgrade during the release; nothing is upgraded before. Set `DATABASE_QUOTA_MB` to the plan's disk size (`8192` for Pro's included 8 GB).
- **Trigger.dev** (project `proj_owlfjcsbkqwtsyyykwqd`):
  - **Deploy.** Deploy the tasks to the Production environment with `trigger deploy --prod --profile omnitarget`. Pass `--native-build` or `--local-build`, because `@depot/cli`'s install script is disabled in `pnpm-workspace.yaml`.
  - **Environment variables.** Set the production variables in the Trigger.dev Production environment too, since the tasks run there, not on Vercel. The workers need:
    - `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`;
    - `APP_ENCRYPTION_KEY` and `APP_ENCRYPTION_KEY_VERSION`;
    - `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, for token refresh;
    - `REDACTION_SUPPRESSION_KEY`;
    - `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_ENVIRONMENT`;
    - the R2 variables (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_JSONL_BUCKET_NAME`): bulk staging, and customer data exports (task 9), which are always written;
    - `CLERK_SECRET_KEY` and `RESEND_API_KEY`, to email the workspace owner when a customer data export is ready (task 9).
  - **Schedules.** These tasks declare their own schedules, created on deploy:
    - `summary-maintenance` (Phase 2 task 8): every six hours at minute 20, with a 30-minute start window;
    - `compliance-maintenance` (task 9): hourly at minute 40, with a 10-minute start window.
    - `sync-sweep` (task 10): every 10 minutes, with a 2-minute start window;
    - `import-reconcile` (task 6): every 10 minutes, with a 2-minute start window. Vercel's Hobby plan allows only daily cron jobs, so the 10-minute reconcile runs here; `vercel.json` keeps the Vercel route as a daily backstop (04:45).
    - `sync-reconcile` (task 10): daily at 03:30, with a 30-minute start window. Since Phase 3 it also refreshes catalog definitions and referenced metaobjects, locations and refunds' line items.
    - `insights-refresh` (task 11): every six hours at minute 50, with a 30-minute start window. It rebuilds store snapshots older than six hours.
    - `shop-context-refresh` (Phase 3 task 5): daily at 04:20, with a 30-minute start window. It reads shop details, markets, delivery zones, policies, locales, analytics, discounts, marketing history and the storefront logo for shops whose stored context is over 20 hours old.

    The store snapshot itself is the `shop-insights` task (task 11), on a `small-2x` machine. It is requested after imports, after sync runs that changed orders or products, by `insights-refresh`, and when a merchant refreshes. The dashboard shows no store data for a shop until its first snapshot exists. After the release, run `insights-refresh` once from the dashboard, so every connected shop gets one without waiting six hours.

    The shop context is also read after each import and by `shop-insights` when it is missing or over a day old. After the release, run `shop-context-refresh` once before `insights-refresh`, so every connected shop's snapshot has its context.

    Confirm in the Production dashboard that all seven are attached and that their first runs complete. The Free plan allows 10 schedules.
  - **Incremental sync** (task 10). Shops get GraphQL webhook subscriptions to `${base}/api/shopify/webhook` on install and reconnect, and from the daily reconcile. Since Phase 3 task 1 these include `app/uninstalled` and `shop/update`, and the install-time REST registrations (`orders/paid` and the same two) use the same endpoint rule. `base` is `SHOPIFY_WEBHOOK_BASE_URL`, falling back to `NEXT_PUBLIC_APP_URL`, and must be HTTPS; in production, leave the variable unset so the app URL is used. Set the same values in the Trigger.dev Production environment. Check a shop's subscriptions after the first install, and watch `sync-sweep` for dead events.
  - **Customer data requests** (task 9). Vercel production needs the R2 variables too: the download route and the post-redaction cleanup read the private bucket. Exports live under `compliance-exports/` in `R2_JSONL_BUCKET_NAME`. That bucket must keep no expiry rule shorter than 30 days, and today it has none. Deadline escalations reach Sentry with the tag `job:compliance-deadline`: add an alert rule for it.
  - **Plan.** Choose Hobby or Pro from measured run volume, and get it approved before purchase.
  - **Login profile.** Use the `omnitarget` profile; the machine's default profile belongs to another organisation.
- Capacity snapshots: `/api/cron/capacity` runs daily from `vercel.json` once production deploys; confirm the first snapshot and that Sentry receives its alerts.

- Vercel production: production variables above, crons from `vercel.json`, and
  the production domain. Preview builds stay off (`deployments.md`).
- Shopify app: compliance webhook URLs and scopes in `shopify.app.toml` point to
  production.

## Shopify approvals

- **Bulk operations** (Phase 2 task 4). Enable bulk query operations for the production app in the Dev Dashboard under Access requests; access is granted immediately.
  - Access lapses after 31 days without a bulk operation. The daily reconcile keeps it active, so confirm that reconcile is scheduled.
  - Without it, every import fails with `not_enabled`.
  - On the dev store, existing installations' tokens were invalidated after this change. Plan for merchants needing to reconnect.

- **`read_all_orders`: a prerequisite for complete historical ingestion** (task 11, decision 6). Request it in the Partner Dashboard under API access requests, and record the outcome here. Without it:
  - a shop's orders are readable for 60 days only, and Phase 2 imports 60 days and marks the orders domain partial (`orderHistoryWindow`, `src/modules/retention/policy.ts`);
  - the 24-month detailed window and the monthly summaries cover only what was imported.

  Status: **approved by the CEO** (Phase 2 decision 1). In effect on both test installations, the dev store and omni-beta: each grants all 20 scopes, and the full 24-month order window applies. The dev store reaches orders older than 60 days (Phase 2 task 1; verified 2026-11-19).

  At release, confirm Shopify's approval in the Partner Dashboard. Every production installation is checked before its import (`checkShopAccess`, recorded in `shop_access`).
- **Protected customer data, Level 1** (orders and customers), and whichever Level 2 fields are used: confirm the approvals before Phase 2 reads those fields.
- **Compliance webhooks act on mirrored data** from migration 0030:
  - `customers/redact` deletes the customer's row and clears identifying fields on their orders;
  - `customers/data_request` stays open, with a Sentry warning, while data is held.

  The fulfilment path for data requests is a Phase 2 deliverable; until it exists, fulfil manually within 30 days.

## Order retention (task 11, migration 0030)

- **Policy:** 24 months of detailed orders and line items, with permanent monthly product, store and anonymised cohort summaries.
- **Pruning is not implemented and not authorised.** It needs a separate approval and a verified production backup and restore before any job exists.
- **The summaries need a schedule.** `refresh_monthly_aggregates` must run after imports and daily (Phase 2). Without it, `retention_status` reports months beyond the window as unsummarised.
- Backups: production needs its own bucket, backup role, R2 tokens, age keys
  and schedule (`backups.md`).
