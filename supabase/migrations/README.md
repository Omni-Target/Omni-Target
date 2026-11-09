# Database migrations

Versioned, ordered SQL migrations applied by [`supabase/migrate.mjs`](../migrate.mjs)
— a small migrate-mongo-style runner for Postgres/Supabase.

## Setup (one-time)

The Supabase **service-role key cannot run DDL**, so the runner connects to
Postgres directly. Add a connection string to `.env.local`:

```
SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Get it from the Supabase dashboard → **Project Settings → Database → Connection
string**. Use the **Session pooler** (port `5432`, IPv4-friendly) or the
**Direct connection** — **not** the transaction pooler on port `6543`, which
doesn't support the migration transactions. `DATABASE_URL` / `POSTGRES_URL` are
also accepted.

## Commands

```bash
pnpm migrate              # apply all pending migrations
pnpm migrate --only 0013  # apply exactly one pending migration (id or NNNN prefix)
pnpm migrate:status       # show applied / pending
pnpm migrate:down         # roll back the last applied migration
pnpm migrate:down --only 0012   # roll back one specific applied migration
pnpm migrate:create "add widgets table"   # scaffold the next NNNN_*.sql file
```

## How it works

- Migrations are `NNNN_name.sql` files, applied in filename order.
- Applied migrations are tracked in `public.schema_migrations` (created
  automatically), so each runs **exactly once** — re-running `pnpm migrate` is
  safe.
- Each migration runs inside its **own transaction**: on error it is rolled back
  and the run stops, leaving the database consistent.
- Migrations should still be written idempotently (`create table if not
  exists`, `create or replace function`) so a manual partial apply can be
  reconciled cleanly.

## Rollbacks

`pnpm migrate:down` runs an optional companion file `NNNN_name.down.sql` for the
most recently applied migration, then removes its tracking row. If no `.down.sql`
exists, it refuses rather than guessing. Write down scripts only where a safe
reversal exists (dropping tables in production loses data).

> Note: statements that cannot run inside a transaction (e.g.
> `CREATE INDEX CONCURRENTLY`) need their own dedicated migration handling and
> are not supported by the default transactional runner.

## Client-role lockdown (0012) — rules for every later migration

`0012_rls_lockdown.sql` enables RLS on every table in `public`, revokes all
privileges from the client roles `anon` and `authenticated`, and removes the
default privileges that would re-grant them on new objects. The application
only uses the service-role key, which bypasses RLS. When writing new
migrations:

- New tables get no client-role access automatically; keep it that way. Enable
  RLS explicitly anyway (`alter table … enable row level security`) so the
  intent is visible in review.
- New functions no longer receive `EXECUTE` through `PUBLIC`. Grant it to
  `service_role` explicitly (as 0009/0010 do) — default privileges cover
  functions created by the migration role, but explicit grants keep reviews
  honest.
- Never grant anything to `anon`/`authenticated`. The single exception is
  `public.keepalive_ping()` (temporary, until nightly backups replace the
  keep-alive workflow).

Verify any environment (read-only, exits non-zero on a violation):

```bash
node scripts/ops/assert-rls-lockdown.mjs --env-file .env.local
```

### Applying 0012 to an environment (production needs separate approval)

1. **Keep-alive first.** Scheduled workflows run from `main`. The old
   keep-alive pinged a table with the anon key, which 0012 denies, so merge the
   updated `.github/workflows/supabase-keepalive.yml` to `main` and confirm the
   `SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_ANON_KEY`) repository secret
   exists *before* applying 0012. The new workflow works both before 0012
   (table-ping fallback) and after it (`keepalive_ping`).
2. Run the assert script (expected: violations listed), then
   `pnpm migrate --only 0012`, then the assert script again (expected: PASS).
3. Smoke-test the app: it uses only the service-role key, so behaviour must be
   unchanged.
4. Rollback: `pnpm migrate:down --only 0012` restores the recorded client-role
   grants (RLS stays enabled; see the down script).

0012 is independent of every other migration: `--only` lets it be applied or
rolled back on its own, in either order relative to later migrations.

**Limitation (verified on the Supabase local stack, Postgres 17):** on
Supabase, `public` also carries default privileges owned by the platform
superuser `supabase_admin`, which grant everything to `anon`/`authenticated`
on objects *that role* creates. The migration role (`postgres`) is not a member
of `supabase_admin`, so no migration can revoke them; 0012 removes only the
ones the migration role controls. The assert script reports the platform-owned
defaults as a WARN and still FAILS on any actual object that lacks RLS or has
client-role grants — run it after every schema change made outside these
migrations.
