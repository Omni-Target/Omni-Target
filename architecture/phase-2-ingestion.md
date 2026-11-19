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
| 2 | Redaction suppression and the ingestion guard (migration 0031). Each other schema change ships with the task that uses it: write RPCs (4), capacity reservations (5), history staging (7), summary adjustments (8) and compliance exports (9) | — |
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
2. **Suppression and guard.**
   - The migration is reversible and changes no existing rows.
   - Each redaction records keyed digests, once, for a shop modelled or not, and they survive the shop's deletion.
   - Only a shop bound to an active workspace is ingestible, and a write holds that workspace against lifecycle changes until it commits.
   - The same bounds apply to each later task's schema: concurrent reservations (5), staging isolation by run (7), adjustments and their totals (8), and every write RPC within its batch bound (4).
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

### Task 3 (foundation): Trigger.dev setup (2026-11-18)

**Installed.** `@trigger.dev/sdk`, `@trigger.dev/build` and the CLI, all at 4.8.5.

**Configured.**
- `trigger.config.ts`: project `proj_owlfjcsbkqwtsyyykwqd`, tasks in `./src/trigger`, `maxDuration` 3600 s, three retries.
- `pnpm dev:trigger` runs the worker with the `omnitarget` login profile and `.env.local`.

**Verified.** The `health-check` task registered on the dev worker (Node 24). A run triggered from code completed.

### Task 3: workers (2026-11-18)

**Per-shop concurrency.** Tasks declare `concurrency: { perKey: 1 }`, and callers pass the shop's domain as the `concurrencyKey`. So at most one run per shop executes at a time, while other shops proceed in parallel up to the environment's limit. This is the current API, replacing the deprecated `queue.concurrencyLimit`.

**Triggering from Next.js.** `src/modules/jobs/trigger.ts` provides the helper:
- **Idempotency.** A global idempotency key covers each shop and reason for one hour, so a retried request queues a single run.
- **Concurrency and tags.** The shop is the concurrency key, and runs are tagged with shop and reason.
- **Never fails the request.** The call times out after 3 s, and a failure is logged rather than raised.
- **First caller.** The OAuth callback queues `shop-access-check` after every connected install.

**Payloads.** They are Zod schemas (`src/modules/jobs/payloads.ts`) checked by the task before it runs. A bad payload fails at once (`TASK_INPUT_ERROR`), with no retries.

**Workers run app code.**
- The `react-server` build condition lets the app's `server-only` modules bundle.
- The `@/` alias resolves.
- The dev worker reads `.env.local`.

**Sentry in workers.** `src/trigger/init.ts` starts Sentry with the app's scrubbing options and no default integrations. `tasks.onFailure` reports a run that failed for good by task, run and attempt, never its payload, and flushes before the worker exits. The local worker has no DSN (it is in `.env.development.local`), so local runs send nothing; staging and production workers get the DSN from their Trigger.dev environment.

**Verified on the dev worker.**
- `shop-access-check` for the dev store ran the app's own modules against staging and Shopify, and completed in one attempt with every domain available.
- An invalid shop domain failed validation without retrying.

### Task 2: redaction suppression and the ingestion guard (2026-11-18; migration 0031)

**`redaction_suppressions`.**
- Each customer and order a `customers/redact` names is stored as an HMAC-SHA256 digest of shop, type and Shopify ID, under `REDACTION_SUPPRESSION_KEY`.
- Entries are keyed by the Shopify shop ID. They hold even for a shop never modelled, and survive shop deletion and reinstall.
- The webhook computes the digests. If the key is missing, the webhook answers 500 so Shopify retries; a redaction is never recorded without its suppression.

**Ingestion guard.**
- `shop_ingestion_open` admits only a shop bound to an active workspace.
- Every task 4 write calls `lock_shop_for_ingestion` first. It holds that workspace against uninstall, `shop/redact` and deletion until the write commits.
- `suppressed_subjects` tells a worker which digests in a batch to drop.

### Task 4: bulk operations, streaming, staging and writes (2026-11-18; migration 0032)

**Client** (`bulk.ts`).
- Starts bulk queries after the Level 2 guard, then reads, cancels and classifies them.
- Re-runs expired or nearly expired results.
- Polls from 5 s, backing off to 60 s.

**Streaming** (`jsonl.ts`).
- Reads line by line, grouping each record with its descendants, including children of inline objects.
- Batches are bounded by rows and never split a record.
- A resume skips every record committed at or before the checkpoint line.

**Staging** (`staging.ts`).
- Copies a result to the private JSONL bucket only when it is large or after a failed attempt.
- Uploads in parts, with a checksum.
- Deletion is verified, and a sweep removes anything older than 8 days.

**Queries and mappers.**
- One bulk query each for catalog, inventory, orders, customers and returns, plus a paginated locations query.
- Each mapper produces rows that satisfy the 0024 and 0029 checks.
- The country-aware city rules moved to `src/lib/location-rules.ts`, so the importer carries no AI code; `locations.ts` re-exports them.

**Writes (0032).** `ingest_catalog`, `ingest_inventory`, `ingest_orders`, `ingest_customers`, `ingest_returns`, `derive_customer_order_facts` and `save_sync_checkpoint`.
- At most 2,000 rows per call.
- The ingestion guard runs first.
- Newer data wins.
- A written record's deleted children are removed.
- Suppressed customers and orders are never restored.
- Orders beyond 24 months are not stored.
- Checkpoints move forward only.

**Shopify behaviour found live on the dev store** (API 2026-07):
- **Bulk operations need enabling.** They must be enabled for the app in the Dev Dashboard (Access requests). Until then Shopify nulls the mutation with `ACCESS_DENIED`, which the client reports as `not_enabled`. Access lapses after 31 days without a bulk operation.
- **Tokens were invalidated.** After bulk operations were enabled, the dev store's refresh token was rejected (401) and the shop had to be reconnected. Treat app-configuration changes in the dashboards as possibly requiring merchants to reconnect.
- **`groupObjects` defaults to `false`.** Without it, children need not follow their parent. The client always sends `true`, and the reader fails loudly on a record outside its group.
- **No connection inside a list.** A connection inside a list field is not supported (refund line items inside an order's refunds). A line's refunded units are therefore its quantity less its current quantity.
- **Nesting depth counts below the top level.** Shopify's two-level limit counts nested connections below the top-level one: orders > returns > return line items is accepted.
- **Node's `fetch` can drop a response body.** It cancels a body whose `Response` was garbage-collected. The result stream holds its `Response` so a slow consumer (staging) cannot lose data silently.

**Verified live.** Every domain's query ran on the dev store and mapped without error:
- 19 products, 32 variants and 13 metafields;
- 40 inventory levels and 2 locations;
- 2 orders, 3 customers.

A real result was also staged in R2, read back identically, and deleted with the deletion verified.

**Still to verify with real data.** The dev store's two orders have no customer and no shipping address, so the bulk export of customer references and destinations is unverified. The access probe now reports such fields as unverified rather than available. (Since verified on omni-beta: see the next section.)

### Real-data export verification (2026-11-19, omni-beta)

omni-beta (`omni-beta.myshopify.com`) is the test store from now on. It was checked with `coverage.live.test.ts`, which combines a bulk export of every domain with a sample of the newest 100 orders through the ordinary API. The ordinary API reports each withheld field, so a field with no value and no denial counts as genuinely empty.

**Effective installation scopes.** All 20 are granted, including `read_orders` and `read_all_orders`; `read_all_orders` is approved by the CEO (decision 1). The order window is the full 24 months, and the oldest reachable order is dated 2026-09-20.

| Field | Result | Detail |
|---|---|---|
| Order customer | Present | 150 of 151 orders. All 150 match an exported customer (60 customers). The other order is a guest order |
| Shipping city, province, country | Present | 150 of 151, the same orders |
| Order discounts | Empty | No order has a discount; nothing was withheld |
| Refunds | Empty | None in the store |
| Returns | Empty | None in the store |
| Line item product and variant | Present | 265 of 266 lines. Every one resolves to the exported catalog of 100,027 products and 100,036 variants. The other line has no product, as a custom line does |
| Line item discounts | Empty | None |

No field was withheld in the sample.

**Still to test with real data.** Discounts, refunds and returns are tested only with synthetic data until the store has some.

### Task 5: capacity guard (2026-11-19; migration 0033)

**Projection** (`src/modules/capacity/projection.ts`).
- **Inputs.** Shopify's counts for the shop: products, variants, customers, orders inside the 24-month window, and orders beyond it.
- **Sampled ratios.** Metafields per product and inventory levels per variant, from a few of the shop's records; the fixture's ratios when not sampled.
- **Row costs.** Each count is multiplied by its measured cost on the 0029 schema, indexes included.
- **Orders beyond 24 months** add summary rows only.
- **Headroom.** 25% is added.
- **Accuracy.** All four fixture profiles project within 25% of their measured size. omni-beta projects at about 120 MB, where task 10's flat 4,100 bytes per product gave about 410 MB.

**Reservations** (`capacity_reservations`).
- **Granting.** `reserve_import_capacity` grants under one database-wide advisory lock, only if current size, plus every active reservation's unwritten bytes, plus the request stays within the critical share (75%) of the quota. Concurrent requests are serialised, so together they can never pass it.
- **Renewal.** `renew_import_capacity` records bytes written, so they are not counted twice, extends the lease, and returns `over_limit` once the real size passes the limit; the import then stops.
- **Expiry.** A reservation abandoned by a crashed worker expires and frees its capacity.
- **Retries.** A retry for the same shop and purpose gets the same reservation back.

**Tests.** Seven database tests: within and beyond the limit, two reservations at the same moment, a retry, progress and `over_limit`, expiry after a crash, release and privileges. Seven projection tests: the four fixture profiles, history beyond the window, a catalog-heavy shop, and invalid counts.

## Dependencies outside the code

| Dependency | Needed for | Status |
|---|---|---|
| Trigger.dev project (Free plan) with development and staging keys | Running tasks (task 3 onward); code and tests proceed without it | To be created |
| Shopify Partner Dashboard: `read_all_orders` and Level 1 protected customer data approved for the app | Production imports beyond 60 days; production customer data | `read_all_orders` approved internally. Shopify's grant is verified per installation (task 1) |
| Webhook subscriptions on the dev store pointing at a reachable staging URL | Live incremental sync tests (task 10) | Local tunnel or the planned staging deployment |
| `REDACTION_SUPPRESSION_KEY` and Trigger.dev keys | Tasks 2, 3 and 9 | Staging values generated locally; production values on the release checklist |
