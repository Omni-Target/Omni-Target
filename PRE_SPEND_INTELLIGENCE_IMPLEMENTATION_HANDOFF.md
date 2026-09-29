# Pre-Spend Intelligence: implementation plan and review handoff

**Prepared:** 29 September 2026  
**Implementation state:** Code is in the current local checkout. Automated checks passed. Merchant-facing local QA and a live Shopify return query remain open.  
**Product promise:** Help a merchant choose one product to test for cold customer acquisition, show the store evidence behind that choice, and expose reasons to pause before spending.

## 1. The decision this feature makes

Omni Target recommends **one gateway product for a first cold-acquisition test** and keeps the existing brief focused on that product. It does not claim to predict Meta CAC, ROAS, or whether an ad will convert. The Shopify data describes observed store orders; it is evidence for choosing a test.

The decision has three separate parts:

| Part | Question | Current output |
| --- | --- | --- |
| Observed role | Did this product appear more often in identified buyers' first orders than later orders? | Gateway, Consideration, Hybrid, or Insufficient Data, with first/later counts and confidence. |
| Test readiness | Is it sensible to prepare a test now? | Planning candidate, review, or hold, with stock, cost, sync, and return reasons. |
| Test priority | Which **ready Gateway** should be tested first? | One candidate selected by readiness, confidence, first-order count, 60-day follow-up, then revenue as the last tie-breaker. |

Stock or return risk can change readiness, but does not rewrite a product's historical role. An out-of-stock Gateway remains a Gateway and is not selected for the next test. If there is no ready Gateway, there is no evidence-backed first-test recommendation.

## 2. What has been implemented

### A. Gateway decision and ranking — implemented

- `src/lib/gateway-decision.ts` now builds a versioned (`logic_version: 2`) decision from accessible paid Shopify orders and the current catalog. It deduplicates order IDs, ignores invalid or future timestamps, groups identified buyers by customer ID, and compares product appearances in first versus later **orders**. Multiple units of one product in an order count as one appearance.
- It retains the 60-day follow-up measure: buyers who placed another store order within 60 days divided by eligible first-order buyers. First orders less than 60 days old are excluded from that denominator. This is not a same-product repurchase measure.
- Role confidence and the first/later denominators are kept in the snapshot. Incomplete order or catalog ingestion withholds a confident role.
- `selectGatewayTestCandidate` chooses only products with observed role `Gateway` and readiness `planning_candidate`. Dashboard and pixel audit use this selection logic; comparison logic is also used for product ordering.
- Product readiness now incorporates a qualified return warning while leaving the store-wide ad-readiness score unchanged. A missing return feed is disclosed as unassessed; it is not treated as a zero return rate.

### B. Buyer outcomes — implemented

- `src/lib/buyer-outcomes.ts` calculates median days from first to second order **among repeat buyers**, shown only when at least five repeat buyers are observed. It produces aggregate results without adding customer contact data to the snapshot.
- A 180-day mature buyer cohort supports an exploratory high-spend entry association. The top-decile group is only used with at least 50 mature buyers and five high-value buyers; tied values that make the group larger than 20% suppress it. A product needs at least three appearances in that group. The feature shows the product's share among high-value first buyers alongside its share among all mature first buyers. This is an association, not proof the product caused higher spend or profit.
- The snapshot's store-wide repeat timing appears in the buyer profile. Product-level high-value association and 60-day follow-up appear with gateway evidence where supported.

### C. Return and refund guardrail — implemented, live validation pending

- `src/lib/connectors/shopify-returns.ts` uses Shopify Admin GraphQL to examine orders created 365 to 60 days before sync. It counts processed returned units, refunded units, and eligible sold units separately by product. Refunds do not automatically count as physical returns.
- A product return rate is shown only with at least 30 eligible units. At 15% or more processed returns, the current policy marks it for review. These are initial policy thresholds and have not been calibrated against live merchant distributions.
- The synchronous query is bounded to 25 pages of 20 orders (500 orders) and a 22-second time budget. Nested connections are also bounded. Any pagination gap, timeout, query error, or exceeded bound withholds **all** calculated return rates from that run rather than publishing a partial rate. Larger stores need a bulk or asynchronous pipeline.
- `src/lib/connectors/shopify-intelligence.ts` runs this as an optional capability and records available, missing-scope, or error state. The configured scopes include `read_orders`, `read_all_orders`, and `read_returns`. A failure does not erase the order-based Gateway decision.
- `scripts/verify-shopify-return-query.mjs` is a read-only one-order schema smoke test for an authorized connected store. It prints status and query errors, never tokens or order/customer details.

### D. Snapshot and merchant-facing surfaces — implemented

- `src/lib/store-data.ts` defines the added aggregate evidence. `src/lib/connectors/shopify.ts` writes it to the store snapshot and bumped `data_quality.schema_version` from 6 to 7. `src/hooks/useStoreData.ts` and `src/app/api/store/data/route.ts` were updated to accept version 7 and refresh older snapshots. No database schema migration was made; the existing JSON snapshot stores the aggregates.
- Dashboard, product cards, the pre-flight sheet, buyer profile, and audit now distinguish role from readiness and show counts, denominators, return state, and blockers. The pre-flight copy avoids promising that a historical Gateway will convert cold traffic.
- Brief screen, generated brief, and PDF remain **single product**. `src/lib/insights-engine.ts` and `src/app/api/generate-brief/route.ts` pass internal evidence as planning context while instructing generation not to turn buyer-value or return observations into customer-facing ad claims.
- `src/lib/gateway-validation.ts` adds a temporal holdout check: choose a Gateway from earlier identified first orders and measure its appearance in later first orders. The aggregate is stored under `data_quality.gateway_signal_validation`. It checks stability of the historical first-order signal only; it does not validate paid-ad performance.

## 3. Data flow for a reviewer

```text
Shopify paid-order + catalog sync ──> buyer outcomes + Gateway role/follow-up
                              │
Shopify GraphQL return feed ───┴────> product readiness and return state
                                      │
                                      v
                         StoreData JSON snapshot (schema 7)
                                      │
                         dashboard / products / audit / brief / PDF
```

The core order feed is limited to accessible **paid** store orders and identified customer IDs. Guest checkout orders cannot support buyer-level first/later or repeat measures. The return feed uses its own mature order cohort, including refunded financial states, so its denominator is not assumed to match the paid-order feed. The interface should keep these denominators distinct.

## 4. Verification completed

| Check | Result |
| --- | --- |
| `npm test` | Passed: 38 test files, 225 tests. Includes new buyer outcome, return reconciliation/pagination, Gateway decision, and temporal validation tests. |
| `npx tsc --noEmit` | Passed. |
| `npm run build` | Passed with Next.js 16.2.1. |
| Live KASA return query | **Blocked by store authorization.** Shopify returned HTTP 401 for the saved access token; the normal refresh path returned `invalid_request` requiring an active refresh token. A Shopify reconnect is needed before testing the query against that store. |
| Manual localhost review | Still needed across dashboard, products, pre-flight, brief, and PDF after reconnection and data refresh. |

## 5. Review and completion plan

### Priority 1 — Reconnect and validate Shopify return access

1. Reconnect the Shopify store in the local app and refresh store data. Confirm the granted scopes and that the new snapshot has `schema_version: 7`.
2. Run the read-only query smoke test against the authorized store: `node --env-file=.env.local scripts/verify-shopify-return-query.mjs KASA`. Do not put credentials or raw order data in the review notes.
3. Confirm GraphQL fields and permissions against an actual response. If the query fails, correct the schema or permission handling and rerun targeted tests plus the build.
4. Test a store with more than 500 eligible orders or an oversized nested connection. It should show return evidence as unavailable/error, never a partial or apparent zero rate.

**Release gate:** Do not present the return guardrail as validated for KASA until the one-order query succeeds and a complete bounded sync has been checked.

### Priority 2 — Manual product-flow QA

On localhost, inspect:

1. Dashboard: one ready Gateway candidate is identified, with first/later counts and reasons. An out-of-stock Gateway keeps its role but is held.
2. Product list and pre-flight sheet: role, readiness, 60-day follow-up, cost/stock, and return state tell the same story. A missing or small return cohort says unassessed/insufficient data rather than low risk.
3. Buyer profile: the repeat-timing median appears only with at least five observed repeat buyers; high-value association may be absent for small or recent stores.
4. Brief and PDF: one product remains the hero; internal buyer/return observations are not presented as ad claims to shoppers.
5. Narrow and wide screens: labels, evidence, and blockers are legible and do not compete with the main recommendation.

Use both a data-rich and sparse store if available. Capture the store name, product, page, and screenshot for any mismatch, without including customer information.

### Priority 3 — Calibrate and harden before broad rollout

- Review whether the 30-unit return sample gate and 15% review threshold fit actual store distributions. They are implementation defaults, not validated universal rules.
- Replace the synchronous 500-order return scan with a complete bulk/asynchronous pipeline for larger stores, preserving the rule that incomplete data produces no rate.
- Add paid campaign spend and conversion data only if Omni Target is expected to validate cold-acquisition performance. The current temporal holdout measures first-order pattern stability, not ad outcomes.
- Revisit true margin and fulfillment costs if the readiness decision should go beyond recorded Shopify unit costs. Current cost coverage is a prompt to verify margin, not a profit forecast.

## 6. Reviewer focus

The most useful review questions are:

- Does the Gateway label mean exactly what the first/later order calculation supports, including guest-order and paid-order limits?
- Is the recommendation always a **ready** Gateway, and do the dashboard, audit, product list, and brief agree on that choice?
- Can any missing, timed-out, partially paginated, or undersized return cohort appear as a reassuring zero/low-risk result?
- Are returned and refunded units kept separate, and can the live Shopify GraphQL response be reconciled to actual orders?
- Are the 60-day follow-up and 180-day high-spend cohorts presented with the right denominator and without causal claims?
- Does any generated customer-facing creative accidentally repeat private merchant evidence as an advertising claim?

## 7. Deliberately outside this implementation

Multi-product carousel briefs, basket-pair recommendations, automatic Meta publishing, deterministic CAC/ROAS predictions, and a change to the store-wide ad-readiness score. These are separate decisions. The cold-acquisition brief stays centered on one gateway product.

## 8. Working-tree note

This work is present as **uncommitted changes** in the local checkout. Some modified files already had user changes before this implementation, including dashboard buyer-profile/derivation and location files. Review the current working tree as a whole and preserve those existing edits; `git diff --stat` alone will not list newly added, untracked files.
