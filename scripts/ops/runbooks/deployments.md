# Vercel deployments

The application deploys from the `omni-target-6gnl` Vercel project.

| Git branch | Vercel environment | Builds? |
|---|---|---|
| `main` | Production | Yes |
| `staging` | Preview, with its own staging-scoped variables | Yes |
| Any other branch (task and PR branches) | Preview | **No**: cancelled by `ignoreCommand` |

## Why other branches do not build

Only `staging` has a dedicated set of Preview variables. Any other branch would
build against the project's shared variables, which belong to production. A
preview must never run with production credentials, so `vercel.json` cancels
those builds before they start:

```json
"ignoreCommand": "if [ \"$VERCEL_ENV\" = production ] || [ \"$VERCEL_GIT_COMMIT_REF\" = staging ]; then exit 1; else exit 0; fi"
```

Vercel reads exit code 0 as "skip" and 1 as "build". A cancelled deployment
appears with state `CANCELED` and never receives runtime variables. Pull
requests are verified by the GitHub `Verify` and `Database` checks and by
local testing, not by preview deployments.

To give another branch its own preview, first scope a complete set of
non-production variables to that branch in Vercel, then add the branch to the
condition above.

## Production

Production builds are not affected by this command. A production release is a
separate, explicitly approved step.
