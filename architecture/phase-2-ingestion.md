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

### Task 6: initial import (2026-11-19; migration 0034)

**First end-to-end import: omni-beta into staging.** The run went through the Trigger.dev dev worker, started by the reconcile job after a deliberately undispatched request.

| Domain | Records read | Written | Rejected |
|---|---|---|---|
| Catalog | 200,074 | 100,027 products, 100,036 variants, 11 metafields | 0 |
| Inventory | 200,074 | 100,038 levels, 2 locations | 0 |
| Customers | 60 | 60 | 0 |
| Orders (window) | 417 | 151 orders, 266 line items | 0 |
| Returns | 151 | 0 (none in the store) | 0 |
| History | skipped | no orders before the window | — |

- **Duration.** 590 s in total.
- **Summaries.** 155 product-months, 3 store months and 3 cohort months; 155 products dated; first and last orders derived for 57 customers.
- **Capacity.** Reserved 159.8 MB (127.8 MB projected plus 25% headroom). The database grew by 94.9 MB, from 16.4 to 111.3 MB, and the reservation was released as completed.
- **Reconciliation.** The reconcile job's dispatch reached Trigger.dev and the run imported the shop. However, its 3 s client timeout fired first, so the job reported the import as "undispatched".
  - The import record stayed correct, because the run's claim marks it running, and a repeat dispatch would have found it busy.
  - Fix: the reconcile job now allows 15 s; the OAuth callback keeps 3 s, since a user is waiting.
- **Staging sweep.** It left one object: a 0-byte file from a failed live test before the response-lifetime fix. It is younger than 8 days, so the sweep will remove it then.

**Not yet exercised with real data.** History beyond the window, refunds, returns and discounts: omni-beta has none yet. The database tests cover them with synthetic data.

### Task 7: history beyond the window (2026-11-19; migration 0035)

**Equivalence, proven on synthetic data.** omni-beta's oldest order (2026-09-20) is inside the window, so a database test proves the history path (`history-equivalence.db.test.mjs`).
- **Test data:** one synthetic history covering six months before the window and two inside it, with:
  - repeat, first-time and returning customers, and guests;
  - discounts, refunds, a test order, a cancelled order, and a line with no product.
- **The two paths compared:**
  - full detail: every order canonical, summarised by `refresh_monthly_aggregates`;
  - the import: window orders through `ingest_orders`; older orders staged in three batches with one replayed, then summarised and discarded.
- **Result:** both paths give identical product summaries (28 product-months), store summaries (8 months), customers' first orders and window cohorts.
- **What the import path leaves:** no detailed order older than the window and no staged rows. A concurrent import staging a conflicting history under the same order IDs is unaffected.

**Defects found and fixed in 0035.**
1. **The window could move during an import.**
   - The claim fixed the window start for the bulk queries, but `ingest_orders` recomputed it on every call.
   - An import still running at 00:00 UTC on the 1st would have refused the window's oldest month as beyond the window, and the history query never fetched it. That month would have been left partly in detail and partly lost, and its summary finalised wrong.
   - Fix: the start is pinned at the first claim (`shop_imports.window_start`). While the import runs, every order write for the shop, the history staging and the summaries use it.
2. **Staging was not isolated by run.**
   - Staging, summaries and discards checked only that the import was running. A superseded run could have discarded the staging of the run that took over, in the middle of its summaries. A month summarised from partial staging stays wrong, because summaries are final.
   - Fix: these calls now require the run holding the import, and a takeover waits for an in-flight batch to commit. The reconcile job can still clear a finished import's staging.
3. **Returning customers were counted as new.**
   - First orders were derived from retained detail only. A customer whose earlier orders were all history therefore counted as new at their first order inside the window, inflating new customers and cohorts.
   - Fix: history staging records `customers.history_first_order_at`, a date on an existing customer row; the orders themselves are only summarised. `derive_customer_order_facts` takes it as the first order when it is earlier.

**Verification.**
- **Mutation checks:** restoring each old behaviour fails exactly the test written for it.
- **Reversibility:** applying 0035 and then rolling it back restores the 0034 schema exactly.

**Still to verify with real data.** History beyond the window needs omni-beta orders processed more than 24 months ago, for example orders imported with a backdated processed date.

### Task 8: summary maintenance (2026-11-19; migration 0036)

**One month per call.** `refresh_summary_month` (used by the import) and `maintain_summary_month` (used by the scheduled task) each refresh one month of one shop, within the 8 s statement timeout. In that call:
- An open month is rebuilt from detail.
- A month is finalised once it ended more than 120 days ago.
- A cohort is rebuilt until it is final at 485 days.
- A final month is never rewritten. A database trigger also refuses any update to a final summary row or an adjustment.

**Adjustments.** For a final month inside the window, a change found by recomputing from detail is appended as an adjustment:
- **What is recorded:** the difference between the recomputation and the final summary plus the adjustments already recorded.
- **Where:** `product_monthly_adjustments` and `store_monthly_adjustments`, classified as refund, return, refund and return, or correction.
- **Result:** effective totals (`product_months_effective`, `store_months_effective`) equal a full recomputation for every measured field.
- **Customer counts** stay as finalised. After finalisation they change only through redaction or customer merges, which are not business corrections.
- **Left as they are:** final months before the window (history), and final months whose detail is gone (pruned). An empty month is never read as a run of negative corrections.
- **Concurrency:** a lock per shop and month means two refreshes record a change once.

**Changed months.**
- **What marks a month:** statement-level triggers on orders and return lines, writing to `summary_dirty_months`. An order marks its month (old and new) when it is added or removed, when Shopify's `updated_at` changes, or when a measured field changes.
- **What doesn't:** customer redaction changes neither, so it marks nothing.
- **Clearing:** a refresh clears the mark first, so a change committed during the refresh marks the month again.

**Scheduling.** The Trigger.dev scheduled task `summary-maintenance` runs every six hours, at minute 20.
- **What it refreshes:** changed months first, then every month that can still change (the last 485 days). Each month is its own call.
- **Which shops:** only shops ready for maintenance, meaning:
  - open for ingestion;
  - orders fully imported at least once;
  - no import in progress, re-checked in the refresh's own transaction. An incomplete import's missing orders are never read as corrections.
- **Failures:** a shop that fails is skipped for the rest of the run, and the run fails so that it reaches Sentry. Months left when the 13-minute budget runs out stay due.
- **Imports:** an import now refreshes its window only when its orders domain succeeded.

**Verification.**
- **Database tests** (`summary-maintenance.db.test.mjs`) cover:
  - late refund, return and cancellation adjustments;
  - effective totals equal to a recomputation;
  - open-month rebuilds;
  - immutability;
  - pruned and history months left untouched;
  - the readiness gates;
  - redaction marking nothing;
  - the month lock.
- **Mutation checks:** removing each guard fails exactly its test:
  - the month lock;
  - the guard for months with no detail left;
  - the immutability trigger;
  - the readiness re-check;
  - excluding the customer field from change detection.
- **Reversibility:** applying 0036 and then rolling it back restores the 0035 schema exactly.
- **The range wrapper:** `refresh_monthly_aggregates` remains for operations scripts and tests, as a month-by-month loop over the same calculation.

**Live run on staging (2026-11-19).** 0036 was applied with no imports active, and omni-beta (shop key 2) was ready for maintenance. One `summary-maintenance` run went through the Trigger.dev dev worker:
- **What it did:** refreshed all 17 due months in 10.9 s, one call each. Three open months (September to November 2026) were rebuilt; 14 months had no orders.
- **Failures:** none.
- **Result:** the rebuilt summaries match the import's exactly (22, 82 and 47 orders; 155 product-months). No months are left marked, and no adjustments were recorded.
- **Not yet exercised on real data:** omni-beta has no order older than 120 days, so it has no final month to adjust. The database tests cover adjustments. The backdated orders due on omni-beta will exercise them.

### Task 9: compliance (2026-11-19; migration 0037)

**Data requests: located, exported, encrypted, delivered, recorded.**
- **Opening an export.** A `customers/data_request` for a customer whose data we hold opens a `compliance_exports` row in the same transaction that records the request. The row names the customer and the orders Shopify listed. The webhook then dispatches the Trigger.dev task `compliance-data-request`.
- **Locating the data.** The task claims the export, then reads the customer's data one database call at a time:
  - their facts;
  - their orders and the named orders, with lines, refunds and returns, a page at a time;
  - the Meta send logs for those orders;
  - webhook payloads about them still in the inbox.
  
  Summaries and cohorts are anonymous and are not included. Nothing of another customer is read.
- **Encrypting.** The document is sealed with AES-256-GCM:
  - under a key derived (HKDF) from the application keyring for this purpose only;
  - bound to its request;
  - under a fresh object key per attempt, in the private bucket under `compliance-exports/`.
  
  Its SHA-256 is recorded with it.
- **Delivering.** The workspace owner is emailed. The email names no customer and carries no customer data. Sending it completes the request (`customer_data_provided`).
- **Downloading.** The owner downloads the file from **Settings → Customer data requests**. The route checks ownership, verifies the checksum, decrypts, and serves the file as a no-store attachment. Anyone else gets a 404, and so does any export that has expired or been withdrawn.
- **Expiry.** Exports expire after 30 days. The file is then deleted, and the row keeps no customer identity (enforced by a constraint).
- **Durability.** A failed dispatch, a stalled run (15 minutes) or a run that failed is dispatched again by the hourly `compliance-maintenance` task. A run that lost its claim can neither read nor record.
- **Deadline escalation.** Requests not yet provided are reported to Sentry once per level:
  - a warning at 10 days left;
  - an error at 3 days left;
  - an error when overdue.

**Redaction on every write path (decision 5).**
- **`customers/redact` now also:**
  - deletes the Meta send logs for the customer's orders;
  - withdraws any export of their data, clearing the subject at once. Its file is deleted right after the webhook, or by the hourly task.
  
  A run exporting at that moment cannot record, and its file is deleted. A retry finds the export withdrawn.
- **The Meta conversions path** (`orders/paid`) now checks the order and customer digests first. For a redacted subject it stores and sends nothing. If the check fails, it sends nothing and the failure is reported.
- **`shop/redact`** withdraws the shop's exports and deletes their files after the shop's data is deleted.
- **What was already covered:** the import RPCs (catalog, inventory, customers, orders, returns, history staging, checkpoints, summaries) check suppression digests and the ingestion guard. The order webhook stores no payload: only the delivery ID, for de-duplication. The thin webhook inbox is task 10.

**Verification.**
- **Database tests** (`compliance-exports.db.test.mjs`) cover:
  - opening exports only when data is held;
  - reads by the claiming run only, and only the customer's own data;
  - recording, completion on notification, owner-only download, expiry and file deletion;
  - dispatch, re-dispatch and escalation once per level.
  
  They also prove the acceptance criteria:
  - after `customers/redact`, a re-import, a historical bulk file, a webhook replay and a retried task each leave the customer absent;
  - after `shop/redact`, every ingestion path refuses the shop (ten RPCs and the import request) and its exports are withdrawn.
- **Mutation checks:** six guards each fail their test when removed:
  - withdrawal on redaction;
  - the run check on reads;
  - the withdrawal check on record;
  - the owner check on download;
  - withdrawal on shop redaction;
  - escalation once per level.
- **Unit tests** cover:
  - the export file (encryption, request binding, tamper detection, key rotation);
  - the workflow and maintenance with in-memory storage;
  - the download route;
  - the settings card;
  - the webhook dispatch and settlement;
  - the Meta path's redaction check.
- **Reversibility:** applying 0037 and then rolling it back restores the 0036 schema exactly.

**Live check on staging (2026-11-19).** `data-request.live.test.ts` ran against omni-beta through the Trigger.dev dev worker, for customer 6714200457280 (9 orders). The request was recorded as the webhook records one, with an event key labelled as a live check: Shopify sends real compliance webhooks only to the production app.
- **Export:** ready in 17 s (9 orders, 15 lines, 15.8 KB).
- **File:** downloaded from the private bucket, matched its recorded SHA-256, and decrypted to exactly this customer's data. No other customer's order was included.
- **Maintenance:** completed with no failures.
- **Defect found:** the export run's own notice and a maintenance run started 4 seconds later both emailed the owner, because maintenance retried any ready export not yet marked as notified.
- **Fix (migration 0038):** maintenance now retries a notice only after the export has been ready for 10 minutes. The database test pins this; without 0038 it fails.
- **The live request** remains on staging as a completed request. Its file expires on 2026-12-19 and is then deleted by maintenance.

### Real-data check of tasks 7 and 8 (2026-11-22; migration 0039)

**omni-beta has grown into a bulky shop:**
- 500,027 products and 500,036 variants;
- 315 customers;
- 2,000 orders over 31 months: 1,500 inside the window and 500 processed before it. The backdated dates are in `processedAt`, which every filter and summary uses.

**The capacity guard refused a full re-import.** It projected 838.7 MB on top of the 117 MB already used, against 393 MB (75% of the staging Free plan). Nothing was written.
- This is the guard working on real data: a 500k-product catalog does not fit the Free plan. Supabase Pro is the intended production plan, and nothing is upgraded now.
- Rows a re-import already holds still count in the projection, because an upsert writes a new row version and the database grows by it until vacuum reclaims the old one.

**Scoped imports (0039).** An import may name its domains: catalog, inventory, customers, orders or returns. None named means all.
- Domains outside the scope are recorded as `not_in_scope`, and history goes with orders.
- The reservation projects only the domains in scope (`importCounts`).
- Task 10's reconciliation uses the same mechanism.

**Defect found and fixed: a re-import could import nothing new.** The first scoped re-import read the orders, customers and returns of the 2026-11-19 import again (151 orders, not 1,500).
- **Cause:** checkpoints are kept per shop and domain, and a new import resumed the previous import's finished checkpoint while its bulk result was still downloadable (7 days).
- **Fix:** an import now resumes only checkpoints written since it first started (`resumableCheckpoint`; both times come from the database clock). A takeover keeps the import's start, so retries still resume.
- **In production** this would have made a re-import, or a reconcile, within a week of the last one silently import nothing while reporting success.

**Real-data result after the fix.** The scoped import of orders, customers and returns succeeded in 78 s:
- 315 customers;
- 1,500 window orders with 2,782 lines, 0 rejected;
- 500 history orders staged, 208 customers given their history first order, and everything staged then discarded;
- 25 window store months, 1,539 product-months and 20 cohorts;
- capacity: 1.95 MB reserved against 1.87 MB of growth.

**Independent history check** (`history.live.test.ts`): the shop's 500 pre-window orders, exported read-only from Shopify and summed from the raw order JSON, give exactly the 6 store months and 426 product-months the import wrote, with zero mismatches.
- No order before the window is held as detail, and nothing is left staged.
- All 208 history customers have their history first-order date.

**Summary maintenance on real data:** 17 due months in 10 s. 12 final months were unchanged, with no adjustments, and 5 open months were rebuilt.

**Still to exercise on real data:** an adjustment needs an order in a final month (more than 120 days old) to change in Shopify, for example a refund, after its month was finalised. Task 10's sync is the path that will bring such a change in.

**Also fixed:** a unit test built a regular expression from random base64 keys. Their `+` and `/` made it match ordinary error text now and then.

### Task 10: incremental sync (2026-11-22; migration 0040)

**Thin webhooks.** Each shop gets GraphQL webhook subscriptions, created on install and reconnect and kept right by the daily reconcile.
- **Fields:** every subscription asks Shopify for identifiers and a field that changes per delivery only (`includeFields`: `id`, `updated_at`, `status`, and so on). Shopify drops a delivery identical to one it sent moments before, so the changing field matters.
- **Topics:**
  - orders: create, updated, cancelled, delete;
  - refunds: create;
  - products and customers: create, update, delete;
  - inventory levels: update;
  - returns: request, approve, decline, cancel, close, reopen, process, update.
- **Recording:** the webhook route records each delivery thin in the inbox before answering, once per webhook ID. The inbox constraint (`webhook_events_thin_payload`) refuses any payload with other keys or nested values, so no customer data can be stored whoever writes.
- **Endpoint:** the delivery address must be HTTPS: `SHOPIFY_WEBHOOK_BASE_URL`, falling back to the app URL. Without one, for example on localhost, subscriptions are skipped.
- **Unchanged:** `orders/paid`, `app/uninstalled` and `shop/update` stay on their existing REST subscriptions and paths.

**Worker.** `sync-shop-events` runs one per shop at a time and drains the shop's inbox.
- **Claiming:** it claims events (run-bound, with a 15-minute lease) and groups them by resource.
- **Fetching:** it fetches each resource's current state from Shopify by ID. The by-ID queries share the bulk queries' Level 1 fields and stay within the cost limit with paged child connections.
- **Writing:** it maps through the bulk mappers and writes through the ingestion functions.
- **What follows from fetching current state:**
  - duplicates are fetched once;
  - out-of-order deliveries converge on Shopify's state;
  - redaction digests, the retention window and the `updated_at` guard all still apply.
- **Deletions:** a resource Shopify no longer has is deleted here. For an order, that includes its lines, refunds and returns; for a product, its variants, metafields and inventory levels.
- **Failures:** a failed event backs off (30 s doubling, at most an hour) and is dead after eight attempts.
- **Sweep:** `sync-sweep`, every 10 minutes, dispatches shops with events waiting and reports dead events.

**Daily reconcile.** `sync-reconcile` lists the orders, products and customers updated since each domain's watermark. The first watermark is the last import's start, less an hour of overlap. It records them as events, so a missed webhook is repaired through the worker. The watermark only moves forward and leaves import checkpoints alone.

**Not covered by the reconcile:** deletions, inventory levels and returns. These arrive through webhooks, and a scoped re-import covers what both miss.

**Verification.**
- **Database tests** (`sync.db.test.mjs`) cover:
  - thin recording once per delivery, and only for open shops;
  - the constraint against customer data;
  - run-bound claims, backoff, dead events and reclaiming a quiet run's events;
  - deletions with what hangs off them, and changed-month marks;
  - watermarks.
- **Mutation checks:** dropping the constraint, the run check or the watermark guard each fails its test.
- **Unit tests** cover:
  - out-of-order and duplicate deliveries converging to one fetch of Shopify's state;
  - deletions;
  - failed fetches and writes;
  - the reconcile repairing a missed webhook;
  - subscriptions (create, correct, leave alone);
  - the route (thin recording, one dispatch, 500 on failure).
- **Reversibility:** applying 0040 and then rolling it back restores the 0039 schema exactly.
- **Test fixtures** that put customer objects in inbox payloads now use thin payloads. Redaction still finds such events by order and customer ID.

**Live check on staging (2026-11-22; `sync.live.test.ts`).** A missed order webhook was simulated: omni-beta's most recently updated order was deleted from the mirror, and the orders watermark was moved to just before its update.
- **Reconcile:** found 2 changed orders and recorded both.
- **Worker:** the real `sync-shop-events` run completed with 2 events processed and 0 failed. The order came back exactly as Shopify has it (same `updated_at`, same line count).
- **Scheduled reconcile, run once:** completed in 8 s. It found both orders again within its overlap window and recorded neither (de-duplication), and the watermarks moved only forward.
- **Ordering:** a `sync-sweep` run that started before 0040 reached staging failed with "function not found". On release, migrations come before the worker deploy.
- **Not verified live:** real Shopify webhook delivery. Staging has no public HTTPS endpoint, so subscriptions were skipped. It needs `SHOPIFY_WEBHOOK_BASE_URL` pointing at a reachable staging URL or tunnel.

## Dependencies outside the code

| Dependency | Needed for | Status |
|---|---|---|
| Trigger.dev project (Free plan) with development and staging keys | Running tasks (task 3 onward); code and tests proceed without it | To be created |
| Shopify Partner Dashboard: `read_all_orders` and Level 1 protected customer data approved for the app | Production imports beyond 60 days; production customer data | `read_all_orders` approved internally. Shopify's grant is verified per installation (task 1) |
| Webhook subscriptions on the dev store pointing at a reachable staging URL | Live incremental sync tests (task 10) | Local tunnel or the planned staging deployment |
| `REDACTION_SUPPRESSION_KEY` and Trigger.dev keys | Tasks 2, 3 and 9 | Staging values generated locally; production values on the release checklist |
