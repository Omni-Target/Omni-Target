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

When an online check is needed, create a dedicated staging deployment with
staging-only variables on `app.staging.omnitarget.co`. Never use an ad-hoc
preview of the production project.

## Production

Production configuration (variables, domains, deployment settings) is left
untouched until the release. See `release-checklist.md`.
