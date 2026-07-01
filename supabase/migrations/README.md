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
yarn migrate              # apply all pending migrations
yarn migrate:status       # show applied / pending
yarn migrate:down         # roll back the last applied migration
yarn migrate:create "add widgets table"   # scaffold the next NNNN_*.sql file
```

## How it works

- Migrations are `NNNN_name.sql` files, applied in filename order.
- Applied migrations are tracked in `public.schema_migrations` (created
  automatically), so each runs **exactly once** — re-running `yarn migrate` is
  safe.
- Each migration runs inside its **own transaction**: on error it is rolled back
  and the run stops, leaving the database consistent.
- Migrations should still be written idempotently (`create table if not
  exists`, `create or replace function`) so a manual partial apply can be
  reconciled cleanly.

## Rollbacks

`yarn migrate:down` runs an optional companion file `NNNN_name.down.sql` for the
most recently applied migration, then removes its tracking row. If no `.down.sql`
exists, it refuses rather than guessing. Write down scripts only where a safe
reversal exists (dropping tables in production loses data).

> Note: statements that cannot run inside a transaction (e.g.
> `CREATE INDEX CONCURRENTLY`) need their own dedicated migration handling and
> are not supported by the default transactional runner.
