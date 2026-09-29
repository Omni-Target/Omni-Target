# Pre-Spend Intelligence: Gateway Product Decision Plan

**Reviewer handoff:** [Implementation status, remaining work, and review checklist](PRE_SPEND_INTELLIGENCE_IMPLEMENTATION_HANDOFF.md). This file records the product rationale and original implementation sequence.

**Status:** Implemented in the current checkout; live Shopify return-query validation awaits store reauthorization  
**Starting point:** The existing single-product gateway classification, product readiness checks, Shopify store snapshot, and single-product Meta brief.  
**Core promise:** Help a merchant choose the strongest *product to test for cold acquisition* and see the evidence and risks before committing ad budget.

## 1. Product decision

Omni Target should answer one question: **Which product should I test first to acquire a new customer, and why?** The output is one lead product and one focused campaign brief. Historical store orders provide evidence for a test, not a guarantee of Meta conversion, CAC, or ROAS.

Keep three judgments separate:

| Judgment | Meaning | Can change because of stock or returns? |
| --- | --- | --- |
| **Observed role** | Whether a product has appeared disproportionately in identified buyers' first orders versus later orders. Existing labels: Gateway, Consideration, Hybrid, Insufficient Data. | No. Historical role remains visible. |
| **Test readiness** | Whether the product can responsibly receive spend now, based on stock, cost coverage, fulfillment, and return evidence. | Yes. |
| **Test priority** | Which *ready* gateway candidate to try first, using comparable evidence and clearly stated tie-breakers. | Yes. |

Avoid a single opaque “intelligence score.” Show the observations, denominators, coverage, and reasons behind each judgment. A gateway on hold remains a gateway; it is not the recommended next test.

### What the merchant sees

1. **Top candidate:** one product, a test/hold/review verdict, and the main evidence supporting it.
2. **Why this product:** first-order count and reach, comparison with later orders, and the number of identified buyers in the sample.
3. **What happened next:** a mature-cohort repeat signal and, where credible, repeat timing or high-value buyer association.
4. **What could waste spend:** stock gaps, missing unit costs, returns/refunds, weak sample size, or incomplete sync.
5. **Next action:** generate the existing single-product brief, review a specific blocker, or gather more evidence.

The brief continues to feature the selected product alone. Optional basket-pair insights belong in a separate post-purchase or merchandising surface, not the cold-acquisition recommendation or creative hooks.

## 2. Current baseline and gaps

- `src/lib/gateway-decision.ts` already compares first and later orders, assigns product roles with confidence, measures a 60-day follow-up cohort, and separates role from stock/cost readiness. Extend this logic rather than replacing it.
- `src/lib/connectors/shopify.ts` fetches accessible orders with `financial_status=paid`, up to 50,000 records, and active products. Guest orders without customer IDs cannot support buyer-level outcomes. “Full transaction graph” is not an accurate description of this dataset.
- `src/lib/insights-engine.ts` and the campaign UI generate a single-product brief. No multi-product carousel format is needed.
- `src/lib/ad-readiness-score.ts` is a **store-level** score. Product return risk should first affect product readiness and priority; changing the store score requires a separately specified, tested aggregation rule.
- `src/components/products/pre-flight-sheet.tsx` currently says a Gateway Product is the “best product for converting new shoppers.” Replace causal or guaranteed language with the actual first-order evidence.
- The store snapshot has `data_quality.schema_version: 6`; cache consumers compare against this version. Any contract change must update all readers and preserve a safe fallback for old snapshots.

## 3. Evidence to add

### A. Repeat timing and buyer value

Use identified customers' chronologically sorted accessible orders. Exclude invalid timestamps, deduplicate order IDs, and distinguish first and later **store orders** from repeat purchases of the same product.

- **Repeat timing:** median days from Order 1 to Order 2 **among customers who placed a second order**. Show the number of repeat buyers and observation period. Do not turn this median into an automatic retargeting window or label it an average.
- **Gateway follow-up:** retain the existing 60-day eligible first-order cohort. Recent first orders cannot yet contribute a fully observed 60-day outcome. For each product, show `buyers_with_another_order / eligible_first_order_buyers`.
- **High-value entry association:** compare products in first orders of a defined, sufficiently mature high-spend cohort against their prevalence in *all* eligible first orders. Show both counts and the baseline. Avoid “VIP magnet,” lifetime-value, or causal acquisition claims; total spend alone does not measure profit or prove that the first product caused later spending.
- **Data minimization:** compute from the customer ID already attached to orders. Do not ingest names, email, phone, or addresses for these calculations.

When cohorts are too small, too recent, or mostly anonymous, return `insufficient_data` and explain why. Select and document minimum sample thresholds using real store distributions before displaying badges.

### B. Return and refund risk

Define the measures before querying Shopify:

- **Returned-unit rate:** completed/processed returned units divided by units sold in a matching eligible order cohort. Requested, declined, canceled, or still-open returns must not be silently treated as completed returns.
- **Refunded-unit/amount evidence:** report separately. A refund is not necessarily a physical return; a return may lead to an exchange or a refund later.
- **Reason:** show a dominant standardized reason only when it exists for enough returned units. Otherwise say “reason unavailable.”
- **Maturity:** use orders old enough for the store's return window, or a clearly named provisional window when policy data is unavailable. Never show “0% return rate” for an empty or immature cohort.

The current paid-only order feed cannot be the sole denominator or reconciliation source: refunded orders can have a different financial status. Add a bounded GraphQL order/return/refund ingestion path using the configured Shopify API version, paginate it completely, and match returned or refunded line items to the original product and order. Check the shop's actual granted scopes and capability result. Failure of this optional feed must leave gateway role evidence intact and mark return evidence unavailable. Initial warning thresholds are product-policy parameters to calibrate, not universal facts; require sufficient eligible units and show the numerator/denominator beside any warning.

**Current bounded implementation:** The synchronous return query considers orders created from 365 to 60 days before sync, up to 500 orders (25 pages of 20). If the order or nested line-item pagination exceeds that bound, it withholds return rates and reports the capability as an error. A Shopify bulk-operation pipeline is needed before this can cover larger stores. This limit is a release constraint, not a claim that larger stores have low return risk.

**Live verification status (2026-09-29):** The connected KASA store has the `read_returns` scope, but Shopify rejected its stored access token with HTTP 401. The app's normal refresh path then received `invalid_request` / “requires an active refresh_token.” The merchant must reconnect Shopify before a live one-order query can verify the schema and before return evidence can sync for that store. No return-rate claim should be released for KASA until that check passes.

### C. Basket affinity

Defer from the core cold-acquisition flow. If built later, calculate unique co-purchased orders, conditional pair rate, and lift relative to the partner product's overall order frequency. Require minimum support and current stock. Surface as a post-purchase or product-page idea, without promising higher AOV or ROAS.

## 4. Decision rules and presentation

1. **Role:** preserve the existing versioned historical classification. Incomplete ingestion withholds a confident role.
2. **Readiness:** an out-of-stock product is on hold. Partial stock, missing cost coverage, material return risk, or unverified delivery requires review. Do not silently add return risk to the store-wide 0–100 score.
3. **Priority:** consider ready gateway candidates first. Compare evidence quality and first-order reach/count, then mature follow-up and risk evidence. Use explicit tie-breakers; never substitute revenue alone for acquisition evidence. A candidate with missing return data remains eligible with that limitation shown, unless another known blocker exists.
4. **Copy:** say “appeared in X of Y identified first orders” and “Z of N eligible buyers ordered again within 60 days.” Say “recommended test candidate,” not “proven Meta winner,” “guaranteed ROAS,” or “converts cold shoppers.”
5. **Fallback:** for stores without enough history, show “insufficient evidence for a gateway recommendation” and a research/test starting point, clearly labeled as a hypothesis.

Do not hard-code a 21–35 day retargeting recommendation from the repeat median. Do not inject return or buyer-value claims into ad copy unless they are substantiated, current, and appropriate for a customer-facing claim.

## 5. Implementation sequence

### Phase 1 — Trustworthy gateway decision

**Work:** Document metric definitions and coverage; tighten first-order/role display; separate role, readiness, and priority in the product list, dashboard, pre-flight sheet, brief, and PDF. Replace existing overconfident gateway copy. Add snapshot contract fields only for evidence the UI will actually display. Bump the snapshot schema version and update cache readers together.

**Done when:** A merchant can see why a ready product ranks first, why an observed gateway is on hold, and why data-poor products have no historical claim. The selected brief still contains one product.

### Phase 2 — Downstream buyer outcomes

**Work:** Add pure, testable cohort calculations for repeat timing and high-value entry association. Keep the existing mature 60-day follow-up as the main downstream measure. Add coverage, sample-size, and recency gates. Present store-wide repeat timing in “Your buyers” and product-specific outcomes alongside gateway evidence.

**Done when:** Single-order customers, anonymous orders, recent cohorts, and tied timestamps produce correct and honest results; high-spend association is compared with a baseline and withheld when underpowered.

### Phase 3 — Return risk guardrail

**Work:** Add scoped Shopify GraphQL retrieval and reconciliation of returns and refunds, with pagination and a bounded sync strategy. Extend product readiness and the pre-flight decision with qualified return evidence. Keep ingestion failures isolated from existing order/catalog insights.

**Done when:** A returned, refunded, exchanged, or pending item is categorized according to its actual state; a refunded order is not omitted solely because it is absent from the current paid-only feed; insufficient or missing data never appears as “low risk.”

### Phase 4 — Recommendation validation

**Work:** Record the recommendation logic version and snapshot date. Compare past recommendations with subsequently observed first-order and 60-day follow-up outcomes, without implying that organic-order correlation predicts Meta performance. Use findings to calibrate thresholds and ordering. Any true ad-performance validation would require separately available campaign spend and conversion data.

**Done when:** We can explain whether the recommendation rule remains useful on new data and identify where it fails.

## 6. Likely code areas

| Area | Files to start with |
| --- | --- |
| Contracts and snapshot version | `src/lib/store-data.ts`, `src/hooks/useStoreData.ts`, `src/app/api/store/data/route.ts` |
| Shopify ingestion and capability reporting | `src/lib/connectors/shopify.ts`, `src/lib/connectors/shopify-intelligence.ts` |
| Product evidence, readiness, and ordering | `src/lib/gateway-decision.ts`, new pure calculation modules, `src/lib/ad-readiness-score.ts` only if a later store-score change is specified |
| Merchant surfaces | `src/components/products/pre-flight-sheet.tsx`, product/dashboard cards, `src/components/dashboard/buyer-profile.tsx` |
| Single-product brief and exports | `src/lib/insights-engine.ts`, `src/app/api/generate-brief/route.ts`, `src/lib/campaigns/brief.ts`, `src/lib/brief-html-template.ts` |

The existing store snapshot is persisted as JSON. First evaluate whether aggregate additions fit that contract and current privacy handling; do not add raw customer or order histories to the snapshot. A database migration is not assumed by this plan.

## 7. Verification and release criteria

- Unit tests for cohort boundaries, missing IDs, duplicate line items, ties, incomplete pagination, return/refund status, and zero or small denominators.
- Contract tests for old snapshots, missing capabilities, and one consistent ranking across dashboard, product list, audit, and brief.
- Verify the actual Shopify GraphQL shape and granted scope behavior for the configured API version against a development or consented store before relying on return evidence.
- Run `npm test`, TypeScript checking, and `npm run build` after implementation. Manually inspect dashboard, pre-flight, generated brief, and PDF with stores that have rich, sparse, and no return data.
- Release with the return feed behind a capability/fallback path. No “safe to scale” or “low return” claim is shown until ingestion is complete and the sample threshold is met.

## 8. Outside this revision

Multi-product carousel briefs, automatic Meta publishing, CAPI, coupon-led hooks, and deterministic ROAS or CAC predictions. Basket affinity can be reconsidered later for merchandising after the gateway decision works well.
