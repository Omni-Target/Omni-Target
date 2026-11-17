# ADR 0002: PostgreSQL for commerce data, R2 for objects

Status: Accepted, 2026-11-17.

Builds on the Phase 1 data model (`architecture/phase-1-data-model.md`) and the task 10 measurements (`architecture/capacity-measurements.md`).

## Context

Task 10 measured the commerce data for a synthetic shop of 70,000 products and 500,000 orders over 36 months. The store needs **733 MB** in Postgres:

| Part | MB |
|---|---|
| Order history: orders, line items, refunds and returns | 355 |
| Current catalog: products, variants, inventory and metafields | 253 |
| Minimal customers | 55 |
| Per-product metrics | 54 |
| Webhook and sync state | 16 |

**How the app reads this data.** Screens and briefs read the current catalog and computed metrics, through indexed queries taking milliseconds. Individual order lines are needed in only four cases, all of them background jobs:

- recalculating metrics;
- applying a late refund or edit;
- redacting a customer;
- re-importing a shop.

**Why a hybrid isn't worth it.** We evaluated keeping hot data in Postgres and moving order history to R2 as compressed columnar files.
- Beyond what Postgres-only optimisation achieves, it would save about 100–200 MB per merchant of that size. At Supabase Pro's disk price that is $0.01–0.03 a month.
- In return it would add a second storage system:
  - a file writer and a compaction job for late updates;
  - rewriting files to redact a customer;
  - consistency checks across both systems;
  - data that the database backups don't cover.
- R2 has no indexes, filters or joins, and fetching an object costs tens to hundreds of milliseconds, so it cannot serve request paths.

## Decision

1. **PostgreSQL is the primary store for structured Shopify commerce data.**
   - **What it covers:** products, variants, inventory, orders, line items, customers, returns and analytical metrics (migrations 0024 and 0025).
   - **What stays put:** order history is not moved to R2.
2. **Optimise before Phase 2 ingestion.** Review the storage-heavy structures while their tables are still empty:
   - catalog fields;
   - metafields;
   - description excerpts;
   - indexes;
   - product metrics;
   - the per-row shop key.

   Validate each proposed saving by measurement against the capacity fixtures, and against every reader of the data. Keep everything that functionality, filtering, analytics and intelligence need. No optimisation is applied without that evidence.
3. **R2 is the object-storage layer.** It holds:
   - generated PDFs and reports;
   - images, uploaded media and documents;
   - Shopify bulk-operation JSONL;
   - encrypted database backups;
   - encrypted archives, such as the brief archive (task 9).

   It is not a query store.
4. **Historical order retention is decided by task 11.**
   - **What gets evaluated:** 12, 24 and 36 months of order history, for their analytical consequences.
   - **Nothing removed early:** no historical order record is deleted or archived on assumptions.
   - **Approval:** the resulting policy needs approval.
5. **Columnar analytical storage is a future option.** That covers Parquet or Iceberg tables in R2, read by DuckDB or Cloudflare Basin SQL. It is reconsidered when one of these is true:
   - synced commerce data passes about 50–100 GB;
   - analytical recalculation needs a database compute tier above Medium;
   - we need analytics across merchants or over many years;
   - measured cost or performance otherwise justifies it.
6. **Supabase Pro is the intended production starting plan,** subject to approval during the production release. Nothing is upgraded before then. The Free plan cannot hold an incident-scale merchant, and it has no automatic backups.

## Consequences

**What we gain:**
- One store and one consistency model for commerce data.
- Request paths stay on indexed Postgres reads.
- Sync, redaction and backups stay simple.

**What we accept:**
- **A larger database.** Postgres is larger than a hybrid would be: by about 100–200 MB per incident-scale merchant once optimised.
- **Shopify as the archive.** Recalculating history beyond the retention window, once task 11 sets one, needs a re-import from Shopify. That requires the `read_all_orders` approval and takes minutes per shop.
- **The cost of Pro,** $25 a month, from the production release.

**Phase 2 ingestion must:**
- **Write only what is kept.** Its mappers write only the columns kept after the decision 2 review.
- **Stream bulk results.** It streams bulk-operation results straight into batched, idempotent Postgres upserts.
  - JSONL is staged in R2 only where the plan's selective rule says it pays off, with a 7-day lifecycle.
  - Shopify's signed result URLs are never stored (migration 0025).
- **Check capacity first.** It calls the import pre-flight check (`checkImportCapacity`) before every full historical import.
- **Delete large shops in batches.** Task 10 measured a single-transaction deletion of an incident-scale shop at 6.2 s locally.
- **Write no cold archive.**

**Task 11 must:**
- Measure storage for each profile at 12, 24 and 36 months and for full history.
- Assess, per metric, what each window would lose.
- Design the aggregates that would preserve what older rows contribute.
- Recommend a policy for approval.

Task 11 deletes, archives and migrates nothing.
