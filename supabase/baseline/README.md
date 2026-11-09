# Schema baseline at migration 0017

A fresh database is built from `0017_schema.sql` plus any later migration. Existing databases keep using `node supabase/migrate.mjs up`.

```sh
DATABASE_URL=postgresql://... node supabase/provision.mjs        # baseline, then later migrations
DATABASE_URL=postgresql://... node supabase/schema-catalog.mjs --compare supabase/baseline/catalog-0017.json
```

`provision.mjs` refuses any database that already has `schema_migrations`, and refuses production's project reference.

## What it records

Captured from staging (`eraycbxedmufsdvhtrvk`) on 2026-11-09:

| Item | Value |
|---|---|
| Server | PostgreSQL 17.6 |
| Extensions present | `plpgsql`, plus Supabase-managed `pgcrypto`, `uuid-ossp`, `pg_stat_statements` and `supabase_vault`. The `public` schema references none of them |
| Migrations | `0001_payment_integrity` to `0017_credit_adjustments` |
| Tables | 17, all with RLS enabled |
| Contents | 152 columns, 20 constraints, 29 indexes, 15 functions, 3 triggers, 0 policies |
| Grants | Application roles only: `anon` and `authenticated` have none, `service_role` has what the app uses |

`catalog-0017.json` is the exact reference, including a hash of every function body. CI builds a fresh database from the baseline and requires it to match.

## Changes made to the raw dump

Made by `capture.mjs`, and nothing else:

- `psql`-only `\restrict` lines removed.
- `CREATE SCHEMA public` made tolerant of an existing schema.
- Grants to the operational backup role removed. Each environment creates its own (`scripts/ops/runbooks/backups.md`).
- Migration IDs recorded.

On a plain Postgres, `provision.mjs` first creates the roles Supabase already has: `anon`, `authenticated`, `service_role` and `supabase_admin`.

## Limits

- This is the **staging** schema, the intended target. Production is reconciled against the finished migration set at the end of the programme.
- The core tables were originally created outside the migrations (see `supabase/archive/legacy-bootstrap/`). The baseline is now the reproducible source for them.

## Regenerating

Take a schema-only dump of a database at 0017, then:

```sh
node supabase/schema-catalog.mjs --out supabase/baseline/catalog-0017.json
node supabase/baseline/capture.mjs raw.sql supabase/baseline/catalog-0017.json > supabase/baseline/0017_schema.sql
```
