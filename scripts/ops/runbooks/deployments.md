# Vercel deployments

Development happens on `staging`, locally and against the staging Supabase
project. `main` and production change only at the production release.

| Git branch | Vercel (`omni-target-6gnl`) | Builds? |
|---|---|---|
| `main` | Production | Yes, unchanged until the release |
| `staging`, task and PR branches | Preview | **No** |

## No preview deployments

Preview builds of this project run with production-scoped variables, so none
are built. Two settings enforce this:

- `vercel.json` `ignoreCommand`, versioned with the code:
  `if [ "$VERCEL_ENV" = production ]; then exit 1; else exit 0; fi`
- The project's Ignored Build Step (Project Settings → Git) holds the same
  command, which covers branches whose `vercel.json` predates it.

Exit code 0 means "skip" and 1 means "build". A skipped push appears as a
`CANCELED` deployment that never receives runtime variables. Pull requests are
verified by the GitHub `Verify` and `Database` checks and by local testing.

## Online staging verification

Online checks use the dedicated staging deployment: Vercel project
`omni-target-staging`, on **`staging.app.omnitarget.co`**, with staging-only
variables. Never use an ad-hoc preview of the production project. (An earlier
plan named `app.staging.omnitarget.co`; that host is not used.)

- It is deployed by hand from an isolated worktree of `staging`; it does not
  build on push.
- Shopify webhooks for staging shops go to
  `https://staging.app.omnitarget.co/api/shopify/webhook`. Locally,
  `SHOPIFY_WEBHOOK_BASE_URL=https://staging.app.omnitarget.co` in `.env.local`
  makes installs, the access check and the daily reconcile keep subscriptions
  there. Production leaves the variable unset (`release-checklist.md`).
- Audit a shop's subscriptions with
  `src/modules/ingestion/webhook-destinations.live.test.ts`.
- The app's compliance webhooks (`customers/data_request`, `customers/redact`,
  `shop/redact`) are app-level, set in `shopify.app.toml`, and always go to
  production. Staging cannot receive them without a separate staging app;
  changing the toml would change production, so it is not done.
- Background jobs for staging run in the local Trigger.dev dev worker
  (`pnpm dev:trigger`), not in a hosted environment. While this machine is off,
  webhooks still reach the staging deployment and wait in the inbox; scheduled
  runs are missed, not replayed, and the next sweep, reconcile, summary and
  insights runs after a restart pick up what accumulated (all are idempotent
  over their windows). A hosted Trigger.dev Production deployment is a release
  requirement (`release-checklist.md`), not a development step.

## Production

Production configuration (variables, domains, deployment settings) is left
untouched until the release. See `release-checklist.md`.
