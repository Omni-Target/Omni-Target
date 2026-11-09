# Archived bootstrap SQL

These files set up the database before the migration runner existed. They are kept for history only. **Do not run them.** A fresh database is built from `supabase/baseline/`.

Why they were retired:

- The core tables (`user_integrations`, `campaigns`, `payments` and others) were created only here, never in a numbered migration. A database could not be rebuilt from the migrations alone.
- `full-migration.sql` and `schema.sql` predate later migrations, such as the 0010 fix and the 0011 columns, and do not create `schema_migrations`.
- `exchange_rate_cache` is defined in three different files.

The numbered migrations in `supabase/migrations/` were not changed. The baseline at 0017 now records the result of everything that ran, and is checked against staging in CI.
