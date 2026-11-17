# Order retention evaluation (Phase 1, task 11)

Evaluated 2026-11-17, under ADR 0002 decision 4. **Approved 2026-11-18 with one amendment** (customer facts, decision 3 below), and implemented by migration 0030 in task 12. **Nothing has been deleted, archived or migrated, and pruning is not authorised.**

## Decision (approved 2026-11-18)

| # | Decision | Where it is implemented |
|---|---|---|
| 1 | Keep **24 months** of detailed order and line-item history. | `ORDER_RETENTION_MONTHS` in `src/modules/retention/policy.ts`; `retention_status` (0030) uses the same window. |
| 2 | **Permanent monthly summaries** by product and by store, so history outlives the retention window. | `product_monthly_metrics`, `store_monthly_metrics` and `refresh_monthly_aggregates` (0030). |
| 3 | **No permanent identifiable customer facts by default.** Customer-level facts need a defined retention purpose and must follow Shopify's redaction requirements. Permanent history uses anonymised cohort statistics. | `cohort_monthly_outcomes` (0030) holds counts and revenue only. Customer rows are kept only while the customer has orders inside the window (`customers.last_order_at`; the table comment states the purpose). `customers/redact` now removes the customer's data from the mirror. |
| 4 | Keep **first-sale and last-sale dates** for products, which hold no personal information. | `products.first_sold_at` and `last_sold_at` (0030). A refresh only ever widens them. |
| 5 | The summaries must support **year-over-year comparison and historical product performance after pruning**. | A month is final 120 days after it ends and is never changed again. A database test deletes a test shop's month of orders and customers, and shows its summaries and sale dates unchanged. |
| 6 | **Track the `read_all_orders` approval** as a prerequisite for complete historical ingestion. Never assume orders older than 60 days are readable without it. | `orderHistoryWindow` in `src/modules/retention/policy.ts` reads 60 days without the scope and names it as missing. The approval is on the release checklist and the Phase 2 prerequisites below. |
| 7 | The approval covers the **summary structures and retention architecture only**. Pruning needs a separate explicit approval and verified backup and restore. | No pruning code exists. `retention_status` is read-only and reports `pruning: not_authorised`. |

The recommendation below is kept as proposed. Its item 3, permanent customer facts, is superseded by decision 3.

## Method

**Measurements.** `scripts/ops/retention-evaluation.mjs` builds the task 10 synthetic shops (36 months of orders each) in throwaway local Postgres. The raw report is `architecture/capacity/retention-2026-11-17.json`.

**Line-level order data at each window.** Orders, line items, refunds, returns and return line items, measured at 12, 24 and 36 months. Sizes are scaled by each table's row share inside the window. A real 24-month copy with the same keys and indexes came within 2.5% of that estimate.

**Monthly aggregates** that would keep what pruned rows contribute:
- **Product by month,** measured twice:
  - with sales spread evenly over all products (the fixtures' worst case);
  - with a Pareto spread, where about 20% of products take 80% of sales, which is closer to real shops.
- **Store by month.**

**Unaffected by retention:** everything else (catalog, customers, metrics, sync state).

**Analytical consequences** are read from the metrics the code computes today and those the plan adds in Phases 4–5.

## Storage

For a shop with 36 months of orders, in MB. "Not order data" is the catalog, customers, metrics and sync state.

| Profile | Not order data | Order lines kept: 12 / 24 / 36 months | Total: keep 12 months + aggregates | Total: keep 24 months + aggregates | Total: keep 36 months |
|---|---|---|---|---|---|
| Small (500 products / 5k orders) | 4 | 1 / 3 / 4 | 6 | 7 | 8 |
| Medium (5k / 50k) | 30 | 12 / 24 / 36 | 45 | 56 | 66 |
| Large (20k / 200k) | 117 | 48 / 97 / 143 | 176 | 219 | 259 |
| Very large (70k / 500k) | 378 | 120 / 240 / 355 | 527 | 633 | 733 |

**Totals with aggregates** use the Pareto spread. With the even worst case they are 3–7% higher: 566 and 652 MB for the very large shop.

**What a year of history costs**, very large profile:

| | Per year |
|---|---|
| Line-level order data | 118 MB |
| Product-month aggregates, Pareto spread | 15 MB |
| Product-month aggregates, even spread | 34 MB |
| Store-month aggregates | negligible (12 rows) |

**What this means:**
- **A cap matters most for long-lived shops.** Without one, the very large shop grows by about 118 MB a year forever. With any cap, it grows by 15–34 MB a year of aggregates.
- **Between the windows the difference is small.** 24 and 36 months differ by 100 MB (14%) on the largest profile, and 12 and 24 months by another 106 MB. On Supabase Pro that is about $0.01 a month per merchant (ADR 0002).
- **Cost doesn't decide this; analytics does.**

## What each window would lose

Today's sync computes from the newest paid orders only, at most about 25,000. For an incident-scale shop that is under two months. So no window would reduce today's accuracy. The constraints come from the planned analytics.

| Metric (code or plan) | Data it needs | 12 months | 24 months | 36 months |
|---|---|---|---|---|
| 30-day orders and revenue, 60-day AOV and velocity, peak days, current channels | The last 30–60 days | Unaffected | Unaffected | Unaffected |
| Per-product windows up to 365 days (product metrics, geography by product, Phase 4 evidence strength) | Order lines for the window | Covered, but no margin to recompute last year's 365-day figure or compare two | Covered, with a full prior year | Covered |
| Gateway decision (first-order cohorts, 90-day half-life) | First orders, weighted by age | Cohorts over a year old hold about 6% of the weight; with aggregates of cohort outcomes, nothing is lost | They hold about 0.4% | Under 0.02% |
| 60-day repeat after a first order; second-order "bridge" product | First and second orders per customer | Cohorts from the last ~10 months, which is enough | More mature cohorts | Same |
| First-order product detection | Each customer's first order and its products | Kept on the customer row while the customer has an order inside the window. As adopted (decision 3), a customer who returns after more than the window without ordering counts as new. | Same, after 24 months without an order | Same, after 36 months |
| Repurchase cycles, including durable goods over 12–36 months | Each customer's order dates | Per customer within the window. Beyond it, only as anonymised cohort outcomes: repeat within 30 to 365 days, by first-order month (decision 3) | Same, with 24 months per customer | Same, with 36 months per customer |
| Customer lifetime value | Lifetime order count and spend | Unaffected: Shopify supplies both on the customer record | Unaffected | Unaffected |
| Year-over-year seasonality | Monthly product and store totals | Covered by monthly aggregates; line-level comparisons (by channel, by city) not possible | Line-level comparisons possible for the latest year | Line-level for two prior years |
| Return and refund rates; return lag | Returns and refunds within about 90–120 days of the order | Covered | Covered | Covered |
| Late refunds, edits and returns on old orders | The order's month and the affected products | Beyond the window, the change is applied to that month's aggregate. The webhook carries the products; a rare lookup to Shopify gives the order's date. | Rarer still | Rarer still |
| Recalculating a metric after its definition changes | Order lines | 12 months; older periods need a re-import from Shopify | 24 months | 36 months |
| Customer redaction | Every row naming the customer | Fewest rows to redact | | Most rows |

## Recommendation (as proposed 2026-11-17)

**Keep 24 months of line-level orders, with permanent aggregates.**

1. **Line-level data.** Orders, line items, refunds, returns and return line items are kept for **24 months** from the order's processed date.
2. **Permanent aggregates,** for every month including retained ones. Each is versioned by `calc_version`:
   - **Product by month:** orders, units, gross sales, discounts, refunded units and amount, returned units, distinct customers in the month, and first-time customers in the month.
   - **Store by month:** orders, gross sales, discounts, refunds, tax, shipping, distinct customers, new and returning customers.
   - **Cohort outcomes by first-order month:** first-time customers, repeats within 30, 60, 90, 180 and 365 days, and 60-day revenue.
3. **Permanent facts,** so long-cycle analysis survives pruning:
   - on customers: `second_order_at` and `last_order_at`, in addition to the first order and its products (0024);
   - on products: `first_sold_at` and `last_sold_at`.

   > **Superseded for customers by decision 3.** Customer rows are bounded by the window rather than permanent. `last_order_at` was added only to mark when a customer leaves the window, and `second_order_at` was not added. Long-cycle repeat behaviour is kept as anonymised cohort outcomes. The product dates were adopted (decision 4).
4. **Pruning, after approval only:**
   - a monthly job, run in batches;
   - only months whose aggregates are final;
   - never for a shop with a sync in progress.

   The verified database backups keep pruned rows until those backups expire under their own retention: at most six months, for the monthly tier.

**Why 24 months:**
- **It covers every window.** Every current and planned window (365 days at most) is covered with a full prior year to spare. That spare year is room for late adjustments, recalculation and one line-level year-over-year comparison.
- **The third year adds little.** Gateway weight from the third year is under 0.4%. Seasonality is preserved by the aggregates, and the customer facts preserve repurchase cycles.
- **It saves 14% now and caps growth.** That is 100 MB on the very large shop, and long-lived shops grow at the aggregate rate rather than 118 MB a year.

**Why not 12 months:** it saves another 106 MB, about $0.01 a month. But it removes the margin on 365-day windows and line-level year-over-year comparison. It also limits recalculation of new metric definitions to one year.

**Why not 36 months:** it costs 100 MB more per very large shop for a third year that the aggregates and customer facts already represent.

## Consequences for the roadmap

As proposed, before approval:
- **Task 12, the pre-Phase 2 optimisation migration,** adds the aggregate tables and the customer and product facts above, if this policy is approved. Pruning itself comes later, as an approved job.
- **Phase 2 initial import:**
  - order lines older than 24 months are streamed into the aggregates and customer facts, and not stored;
  - a re-import from Shopify can rebuild either.
- **The capacity pre-flight** (task 10) projects imports with all orders. With retention it should project only the last 24 months of lines, plus aggregates.
- **Historical data access depends on Shopify approval.** Orders older than 60 days are only reachable with the `read_all_orders` approval, which is still to be confirmed in the Partner Dashboard (Phase 0, blocker B2).

### As implemented (task 12, migration 0030)

**Built:**
- the three summary tables;
- product sale dates;
- bounded customer rows, with customer redaction against the mirror;
- `refresh_monthly_aggregates` and `retention_status`.

No pruning exists. The summaries are built from stored order lines, so nothing is summarised that was not first imported.

**Prerequisites before Phase 2's historical import:**

1. **`read_all_orders` approval** (Partner Dashboard, API access requests).
   - Without it, an import reads 60 days (`orderHistoryWindow`) and marks the orders domain partial.
   - The approval is tracked on `scripts/ops/runbooks/release-checklist.md`.
   - This does not block anything built so far.

**Phase 2 obligations:**

- **Import window.** Detailed orders are imported for the 24-month window only.
  - Reading older history into the summaries alone, for shops with more than 24 months, is a Phase 2 design choice to bring for approval. It also needs `read_all_orders`.
- **Refresh scheduling.** Call `refresh_monthly_aggregates` after each import, and daily over `aggregateRefreshRange()`, the months not yet final.
- **Mappers.**
  - Maintain `customers.last_order_at`.
  - Follow 0029's rules: a sparse metric row only with activity, and no duplicate of the main city or currency field.
- **Data requests.** `customers/data_request` stays `open` with a Sentry warning when data is held.
  - Phase 2 provides the fulfilment path within Shopify's 30 days: an export of the customer's rows to the merchant, or a documented manual procedure.
- **Redaction.** Re-imports and webhooks must not restore data that a `customers/redact` removed. Phase 2 checks how Shopify returns a redacted customer's orders, and suppresses accordingly.
- **Capacity pre-flight.** It projects only the retained 24 months of order lines, plus the summaries.
- **Pruning.** Pruning comes only after a separate approval and a verified backup and restore. When it does, it is a batched job that:
  - touches only months whose summaries are final (`retention_status.months_beyond_unsummarised = 0`);
  - never runs during a shop's sync.

## Assumptions

- **The data is synthetic.**
  - Orders are spread evenly over time. Real shops that are growing hold more of their orders in recent months, so the savings from a cap are somewhat smaller.
  - Real sales concentration varies, so the aggregate sizes sit between the Pareto and even figures.
- **Timings were not measured for this evaluation.** Retention changes storage, not request latency: request paths read metrics, which are unaffected. Task 12 later measured the real summaries and their refresh (`storage-optimisation.md`, "Retention summaries"). For the very large shop: 56.2 MB over 36 months, 18.7 MB a year rather than the 15 MB estimated above, and at most 1.0 s for a one-month refresh, locally.
