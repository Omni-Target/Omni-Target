# Phase 2: commerce ingestion and the intelligence data pipeline

Authorised 2026-11-18. This document maps the Phase 2 requirements onto the Phase 1 architecture and sets the tasks, their dependencies and acceptance criteria. Every task ships as its own PR into `staging`.

## Binding decisions (2026-11-18)

| # | Decision | Consequence in this plan |
|---|---|---|
| 1 | `read_all_orders` approved internally; verify app configuration and granted scopes; import beyond 60 days | Task 1 verifies the configuration and each installation's granted scopes. The import window comes from the granted scopes (`orderHistoryWindow`), never from assumption |
| 2 | Level 1 protected customer data only; verify approval and permitted fields before importing; avoid Level 2 | Task 1 probes the fields per shop. Queries request no name, email, phone or address lines, and a withheld field is recorded and left null |
| 3 | 24 months of detailed orders; older history only as monthly summaries; no pruning of existing records | Orders older than 24 months pass through a temporary staging table into the summaries and are discarded. They never enter the canonical tables (task 7) |
| 4 | Durable Trigger.dev workflows locate, export and deliver customer data requests within Shopify's deadline | Task 9 |
| 5 | Durable redaction suppression: nothing redacted is restored by re-imports, bulk operations, replays or retries | Task 2 (schema) and task 9 (enforcement, with a test for every path) |
| 6 | Trigger.dev maintains summaries, one month per database operation (8 s timeout); final summaries immutable; late changes as separate adjustments | Task 2 (adjustments) and task 8 |
| 7 | PostgreSQL for structured data; R2 for bulk JSONL staging, documents, reports, archives and backups | Task 4 (JSONL staging with verified cleanup) |
| 8 | Capacity guard with the optimised schema, 24-month retention, summaries, indexes and headroom; concurrency-safe reservations | Task 5 |
| 9 | Supabase Pro intended at release; nothing upgraded now | No plan change |

## Design choices made within these decisions

- **Thin webhook events.** Shopify's order webhooks carry names, emails and addresses whenever the app is approved for them. So the inbox stores only what identifies the change (topic, resource ID, `updated_at`). The worker then reads the current record through GraphQL with the Level 1 field set. No Level 2 data is ever stored, out-of-order deliveries resolve to the latest state, and a redacted customer cannot return through a replayed payload.
- **Suppression keyed by digest.** A redacted customer is recorded as an HMAC-SHA256 digest of shop and customer ID, keyed by a server secret (`REDACTION_SUPPRESSION_KEY`). The suppression list therefore holds no usable customer identifier. Every write path compares digests before storing a customer reference. A shop that is pending deletion or deleted is refused at the start of every ingestion write.
- **Data requests are delivered in the app.** The export is stored in a private R2 prefix. The workspace owner is notified by email, which carries no customer data, and downloads the export from an authenticated settings page through a short-lived signed URL. Exports expire after 30 days.
- **R2 staging is selective** (Phase 0 §8.6). JSONL streams straight from Shopify's signed URL. It is copied to R2 only when it is larger than a threshold, or after an attempt for that domain has failed. Each staged object is deleted when its import commits, and a bucket lifecycle rule plus a sweep task make that cleanup verifiable.
- **No new database driver.** Workers write through supabase-js RPCs in bounded batches, each well under the 8 s statement timeout.

## Tasks

| # | Task | Depends on |
|---|---|---|
| 1 | Shopify access verification: app configuration, granted scopes, Level 1 field probe and the per-shop capability matrix (`shop_access`) | — |
| 2 | Control-plane migration: redaction suppression, capacity reservations, summary adjustments, history staging, compliance exports, and bounded ingestion write RPCs | — |
| 3 | Trigger.dev foundation: SDK, configuration, queues with per-shop concurrency, Sentry and logging in workers, and triggering from Next.js with idempotency keys | — |
| 4 | Bulk operations client: start, poll and finish webhook, cancel, at most 5 per shop, streaming JSONL with `__parentId`, checkpoints, expired URLs, selective R2 staging and domain mappers | 2 |
| 5 | Capacity guard: projection from the optimised schema, 24-month window, summaries, indexes and headroom; concurrency-safe reservations | 2 |
| 6 | Initial import workflow: reservation, per-domain bulk imports, checkpoints and resume, coverage, refresh, release | 3, 4, 5 |
| 7 | History beyond 24 months: staged, summarised month by month, discarded | 6 |
| 8 | Summary maintenance: scheduled refresh one month per operation, immutable final months, adjustments for late refunds and returns | 2, 3 |
| 9 | Compliance: data request workflow (locate, export, deliver, deadline escalation) and redaction suppression enforced on every write path | 2, 3 |
| 10 | Incremental sync: GraphQL webhook subscriptions, thin inbox events, worker fetches by ID, daily reconcile by watermark | 3, 4, 9 |
| 11 | Read path: metric computation from canonical data, the compatibility adapter for the existing dashboard and briefs, and no full sync inside any HTTP request | 6, 8, 10 |
| 12 | Scale and recovery verification: 70k / 500k fixture through the pipeline, kill and resume, expired URL, duplicates, denied fields, R2 cleanup, dev-store end to end | all |

### Acceptance criteria

1. **Access verification.**
   - `read_orders` and `read_all_orders` are in `shopify.app.toml` and `SHOPIFY_REQUIRED_SCOPES`.
   - For each staging shop, a report records the granted scopes, the oldest reachable order, and every Level 1 and destination field as available or withheld.
   - `shop_access` holds the per-domain availability.
   - Level 2 fields are never requested.
2. **Control plane.**
   - The migration is reversible and changes no existing rows.
   - Database tests cover suppression lookups, reservations under concurrent callers, adjustments and the totals that include them, staging isolation by run, and every write RPC staying within its batch bound.
3. **Trigger.dev.**
   - Tasks are thin wrappers over module services.
   - At most one import runs per shop and data domain.
   - Triggers use idempotency keys.
   - A failing task reports to Sentry with the shop and run, and nothing more.
   - Unit tests run without the Trigger.dev cloud.
4. **Bulk client.**
   - Recorded JSONL fixtures stream with bounded memory.
   - Parents link to their children.
   - A resume skips committed lines.
   - An expired URL re-runs the operation.
   - A denied field yields a partial result, not a failure.
   - A staged R2 object is deleted after commit, and a sweep proves none is left.
5. **Capacity.**
   - Two imports reserving at once cannot jointly exceed the critical share.
   - A reservation is released on success, failure or expiry.
   - Projections stay within 25% of the measured fixture sizes.
6. **Initial import.**
   - The 70k / 500k fixture imports end to end.
   - A worker killed mid-batch resumes with no duplicates or gaps (counts and checksums).
   - A second run is idempotent.
   - Coverage records partial domains with their reasons.
7. **History.**
   - Months older than 24 months appear only in the summaries, with the same totals as the full-history summaries.
   - Staged rows are gone after the run.
   - No canonical row older than the window is written.
8. **Summaries.**
   - Each database call refreshes at most one month.
   - Final months never change.
   - Late refunds and returns on final months are recorded as adjustments.
   - The totals equal a full recomputation.
9. **Compliance.**
   - A data request is located, exported, encrypted at rest, delivered in the app and recorded, with escalation before the deadline.
   - After `customers/redact`, the following each leave the customer absent:
     - a re-import;
     - a bulk operation;
     - a webhook replay;
     - a task retry.
   - After `shop/redact`, every ingestion path refuses the shop.
10. **Incremental sync.**
   - Duplicate deliveries are processed once.
   - Out-of-order deliveries converge to Shopify's latest state.
   - The daily reconcile repairs a missed webhook.
   - No webhook payload with customer data is stored.
11. **Read path.**
   - Every HTTP route reads canonical data.
   - Dashboard and brief output match the snapshot path on the dev store, except where the snapshot was wrong (documented).
   - No full sync runs inside a request.
12. **Verification.** A report gives timings, batch durations against the 8 s timeout, run counts, R2 cleanup and the dev-store end-to-end result.

## Task results

### Task 1: access verification (2026-11-18)

**Configuration.** `shopify.app.toml` and `SHOPIFY_REQUIRED_SCOPES` declare the same 20 scopes, including `read_orders` and `read_all_orders`. A unit test keeps them aligned.

**Live check of the dev store** (Omni Dev, through the staging credential). This used `checkShopAccess` with the opt-in `vitest.live.config.mjs`; the report is stored in staging's `shop_access`.
- **Scopes.** The installation grants all 20, including `read_orders` and `read_all_orders`.
- **History.** The oldest reachable order is dated 2026-05-26, beyond 60 days, so `read_all_orders` is in effect and the import window is the full 24 months.
- **Domains.** All seven are available.
- **Fields.** None was withheld: the Level 1 customer fields (order count, amount spent, created date), the order's customer reference, and the destination city, province and country. The shop had orders and customers to test against.

**Production stores.** A development store shows what the app's development access allows. Production installations are checked the same way, per shop, before every import, and the import plans only from what that check recorded.

## Dependencies outside the code

| Dependency | Needed for | Status |
|---|---|---|
| Trigger.dev project (Free plan) with development and staging keys | Running tasks (task 3 onward); code and tests proceed without it | To be created |
| Shopify Partner Dashboard: `read_all_orders` and Level 1 protected customer data approved for the app | Production imports beyond 60 days; production customer data | `read_all_orders` approved internally. Shopify's grant is verified per installation (task 1) |
| Webhook subscriptions on the dev store pointing at a reachable staging URL | Live incremental sync tests (task 10) | Local tunnel or the planned staging deployment |
| `REDACTION_SUPPRESSION_KEY` and Trigger.dev keys | Tasks 2, 3 and 9 | Staging values generated locally; production values on the release checklist |
