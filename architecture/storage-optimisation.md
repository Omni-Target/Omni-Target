# Storage optimisation review (Phase 1, task 12)

Measured 2026-11-18, under ADR 0002 decision 2. Every candidate was measured on its own, and checked against the code that reads the data, before any decision.

## Method

`scripts/ops/storage-optimisation.mjs` builds the very large capacity fixture in throwaway local Postgres:
- 70,000 products and 500,000 orders over 36 months;
- a Pareto spread of sales, where about 20% of products take 80% of units.

The fixture's mirror is 732 MB. The raw report is `architecture/capacity/optimisation-review-2026-11-18.json`.

**One candidate at a time.** For each candidate, the affected tables are copied twice: once unchanged (the control) and once with the change. Both copies are rebuilt with the same indexes, so the difference belongs to that candidate alone.

**Indexes** are judged on query time. Each representative query is timed with the index and without it, inside a transaction that is rolled back, with a 60-second limit.

The tool measures the 0024/0025 design, as it was before this task's migration.

## Results and decisions

| Candidate | Saving | What reads it | Decision |
|---|---|---|---|
| **Integer shop key** instead of the 16-byte shop UUID, in every row and index | **60.1 MB (8.2%)**: 698 → 638 MB across the 20 tables | Only joins; nothing outside the database sees it | **Apply** (migration 0029) |
| **Sparse product metrics**: a row only when the product sold in that window | **37.1 MB (5.1%)**: 51 → 14 MB | Metric readers; a missing row means no activity | **Apply** (0029, with a check that every row records activity) |
| **Raw city and presentment currency only when they differ** from the city and the shop currency | 7.0 MB (1.0%); this fixture never differs, so real shops save less | Readers fall back to the main field | **Apply** (0029, with checks that enforce it) |
| **Inventory levels only where a shop has several locations**; otherwise the variant's own quantity | 159 bytes per level; about 33 MB for a single-location shop of this size | Per-location readiness (Phase 3), which needs several locations to say anything | **Apply** as a Phase 2 import rule; no schema change |
| **Metafield values over 1,000 characters** | None measured (the fixture has none) | The catalog-claims reader discards values over 1,000 characters | **Apply** (0029: the limit drops from 2,000 to 1,000, matching the reader) |
| **`return_line_items_line_item_idx`** (index) | Under 1 MB | No planned query: returned units per product took 62.7 ms with it and 62.8 ms without | **Drop** (0029) |
| Metafield allow-list (one key of three) | 40.1 MB (5.5%) | The claims reader uses every non-reference metafield of 1,000 characters or less, from any namespace, as factual evidence | **Reject:** it would remove AI evidence |
| Description excerpt of 300 characters instead of up to 600 | 6.0 MB (0.8%) | The copy-evidence and factual-claims checks, and the hooks prompt ("verified description and catalog claims") | **Reject:** it would remove AI factual evidence |
| Variant `selected_options` dropped (the title repeats the values) | 9.5 MB (1.3%) | Structured option names such as Size and Colour, which titles lose; needed for variant-level analysis (Phase 3) | **Reject:** small saving, real loss |
| Metafield key dictionary (namespace and key replaced by a per-shop key id) | 11.5 MB (1.6%) | Every metafield write and read would need a key lookup | **Reject for now:** under 2%, for added ingestion complexity. Revisit if metafields grow. |
| `orders_customer_idx` dropped (31.5 MB, the largest index) | 31.5 MB (4.3%) | One customer's orders (redaction, repeat lookups): 0.4 ms with it, 38 ms without. Cohort repeat query: 317 ms with it, 428 ms without in its set-based form; over 60 s without it in its correlated form. | **Keep** |
| `order_line_items_product_idx` dropped | 9.4 MB (1.3%) | Single-product drill-downs, timed after the migration (see below); batch metrics don't use it (62 ms either way) | **Keep:** see the validation below |

**Accepted savings on this fixture:** about 105 MB (14%), from the integer shop key, sparse metrics, order duplicates and the index. A single-location shop of this size saves about 33 MB more in inventory levels. Retention (task 11) is separate, and adds its own saving once pruning is approved.

## Validation after migration 0029

**Before and after.** `scripts/ops/capacity-fixtures.mjs` was re-run on the optimised schema. It now writes what Phase 2 will write:
- presentment currency and the raw city only when they differ;
- product metrics only for products with sales in the window.

The report is `architecture/capacity/fixtures-2026-11-18.json`. It uses the same even spread of sales as the task 10 baseline:

| Profile | Before (task 10) | After (0029) | Saving |
|---|---|---|---|
| Small (500 products / 5k orders) | 7.9 MB | 7.1 MB | 10% |
| Medium (5k / 50k) | 66.0 MB | 58.2 MB | 11.8% |
| Large (20k / 200k) | 259.5 MB | 229.0 MB | 11.8% |
| Very large (70k / 500k) | 733.0 MB | 643.5 MB | 89.5 MB (12.2%) |

**Why the even spread saves less here.** With sales spread evenly, most products sell within 365 days, so sparse metrics save less than under the Pareto spread above. Real shops sit between the two.

**Order lines index.** On a typical product (14 lines, the median), one product's 365-day sales took 0.8 ms with `order_line_items_product_idx` and 164 ms without it. The earlier test used the best-selling product, where an index can't help. **Decision: keep.**

**Capacity pre-flight.** The coefficients now follow this schema: 4,100 bytes per product and 880 per order, with 25% headroom. Every profile is projected at 1.13–1.35 times its measured size.

**Migration 0029.** It converts in place, keeping any rows, and its down script converts back. A local check seeded one row in every commerce table before 0029, then ran up, down and up. All 20 rows survived each step, with the correct shop.

## Retention summaries (migration 0030)

Task 11's approved policy adds storage rather than saving it. It saves only once pruning is separately approved. Measured with the real tables and refresh function on the Pareto fixtures (36 months): `scripts/ops/retention-summaries.mjs`, report `capacity/retention-summaries-2026-11-18.json`.

| Profile | Summaries | Share of the mirror | Full refresh (36 months) | Slowest one-month refresh | `retention_status` | `customers/redact` |
|---|---|---|---|---|---|---|
| Small | 0.77 MB | 11.0% | 0.2 s | 22 ms | 8 ms | 5 ms |
| Medium | 5.9 MB | 10.3% | 1.5 s | 80 ms | 28 ms | 5 ms |
| Large | 22.7 MB | 10.1% | 5.0 s | 0.33 s | 118 ms | 5 ms |
| Very large | 56.2 MB | 8.9% | 11.7 s | 1.0 s | 0.38 s | 10 ms |

**Where the space goes.**
- **Product-month rows** take almost all of it: about 180 bytes each, including indexes. That is 18.7 MB per year of history for the very large shop. Task 11 estimated 15 MB from a narrower stand-in table.
- **Store and cohort rows** add 36 rows each.
- **Product sale dates** add 1.1 MB (2.2%) to the very large shop's `products`.

**Against 24-month retention.**
- Line-level history costs 118 MB a year for the very large shop; the summaries cost 18.7 MB a year.
- Once pruning is approved, each year beyond the window saves about 100 MB.
- Until then the summaries are an extra 9–11% of the mirror.

**Timing.**
- **The 8 s timeout.** API calls run under PostgREST's `authenticator` role, which has an 8 s statement timeout on Supabase (read from staging). `service_role` has none of its own.
- **Full refresh.** The very large shop's 11.7 s local full refresh could exceed that timeout on shared compute.
- **Month by month.** The slowest single month took 1.0 s, so Phase 2 refreshes one month per call.
- **Refresh scope.** The refresh reads only its range of months for units and sale dates, so a one-month call does one month's work.

## What stays as it is

These were measured or reviewed and left unchanged:
- **Product descriptions.** The excerpt stays at up to 600 characters.
- **Metafield namespaces.** All are kept, with values up to 1,000 characters.
- **Variant option structure.**
- **Product metric windows.** Phase 4 decides them. With sparse rows, each window costs only the products that sold in it. Here that is 2,709 products for 7 days, 8,969 for 30, 20,187 for 90 and 45,991 for 365, against 70,000 in the catalog.
- **Every remaining index.** Each serves a planned query or a foreign key.
