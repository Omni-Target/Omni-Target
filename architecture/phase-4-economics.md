# Phase 4: Product economics and advertising budget engine

Authorised 2026-11-24, after Phase 3 was accepted. Phase 4 replaces every advertising budget figure Omnitarget produces with a deterministic, auditable engine:
1. It first decides whether a product can pay for its own acquisition.
2. Only then does it recommend how much to spend, within the merchant's own limits.

It builds on Phase 3's verified product, variant, inventory, return, refund and data-quality structures (`phase-3-data-model.md`) and recreates none of them.

## Constraints carried forward

Every approved decision from earlier phases still binds:
- one shop per workspace;
- PostgreSQL for structured data;
- Level 1 customer data only;
- Trigger.dev for background work;
- bounded, idempotent operations;
- reversible migrations;
- the existing CI, logging and security architecture.

Development stays on `staging`. Nothing is pruned or removed irreversibly without separate approval.

Phase 4 adds:
- **Deterministic numbers only.** AI may explain a result. It never produces, changes or overrides a financial figure or restriction.
- **First-order economics only.** No customer lifetime value is used to justify spend.
- **No advertising actions.** No Meta publishing and no real spend; campaign results are only evaluated.
- **No silent zeros.** A missing, stale or unverified cost is never treated as zero, and an estimate is never presented as an observation.

## Where the calculations live

- **PostgreSQL:**
  - holds the configuration: the versioned policy and the merchant's cost inputs and spending limits;
  - aggregates the evidence with set-based SQL over the mirror;
  - stores every recommendation with its complete inputs, assumptions, policy version and calculation version.
- **Formulas:** a pure, versioned TypeScript module (`src/modules/economics/`). It turns the stored evidence, policy and merchant inputs into economics, a verdict and a budget.
- **Why this split:**
  - The formulas are deterministic and testable in isolation with golden cases and property tests.
  - Every stored recommendation can be recomputed from its recorded inputs and compared, which a test checks.
  - The database stays the single record of what was recommended and why.

## Task 1: how budgets are produced today

Two implementations exist. Both were read in full for this audit; they are not paraphrased from the Phase 0 report.

| | Where | Who sees it |
|---|---|---|
| **Production engine** | `main` at ad56bfc | Merchants today. `main` is 138 commits behind `staging` |
| **Staging interim** (Phase S0.6) | `staging` | Nobody yet. It withdrew the production formula and shows only the merchant's own cap |

### The production engine (main@ad56bfc)

**Calculation path:**
0. **Low-data shortcut** (`insights-engine.ts:1015-1125`). A store with fewer than 20 orders, generating without a selected product, gets a fixed plan:
   - **15 USD/day** at the exchange rate, for 14 days;
   - strategies of 0.7, 1.0 and 1.4 times that;
   - an 18 USD/day overseas figure.

   None of the steps below run for such a store.
1. **Store revenue.**
   - `insights-engine.ts:1228-1232`: `avgMonthlyRevenue = revenue_avg_3_months || revenue_last_30_days || 0`. Nothing populates `revenue_avg_3_months`, so the input is always `revenue_last_30_days`.
   - That is the sum of `total_price` over the last 30 days (`connectors/shopify.ts:389-391`), which includes tax and shipping.
   - Only orders with `financial_status=paid` are fetched (`shopify.ts:314`), so refunded and partially refunded orders are excluded.
   - The figure is converted to USD at the shop's exchange rate.
2. **Revenue tier** (`insights-engine.ts:1234-1251`): a 14-day total test budget in USD.
   | 30-day revenue (USD) | Tier label | Total test budget |
   |---|---|---|
   | under 2,000 | Starter | 150 |
   | 2,000 to 10,000 | Growth | min(12% of revenue, 800) |
   | over 10,000 | Scale | min(7% of revenue, 2,000) |

   The baseline daily figure is that total ÷ 14.
3. **Price guardrail** (`insights-engine.ts:1253-1290`, `budget-evidence.ts:18-23`):
   - **The price used:** the first of these that exists:
     1. the selected product's first-variant price;
     2. the store's average order value;
     3. the median catalog price;
     4. a hard-coded 25 USD.
   - **The guardrail:** 50% of that price.
   - **Daily figure:**
     - if the guardrail exceeds 3 × baseline: the baseline, plus a "premium product" warning;
     - otherwise: max(baseline, guardrail).
   - **Rounding:** the result is converted back to the shop currency and rounded (`:1292-1293`).
4. **Three strategies** (`:1363-1388`):
   - "Dip Your Toe" = 0.7 × daily;
   - "Sweet Spot" = 1.0 × daily;
   - "Full Send" = 1.4 × daily.
5. **Campaign-goal multipliers** (`:1355-1361`): Drive sales 1.0, Brand awareness 0.6, New collection 1.2, Retarget 0.4.
   - They are stored but not applied by the engine.
   - They are applied later, inconsistently (step 8).
6. **Overseas budget** (`market-geography.ts:479`): $18, $25 and $40 per day, converted at the exchange rate, or from a hard-coded local table.
   - It is shown whenever the currency is not a Tier-1 currency, or a Tier-1 store has any overseas order (`budget-planner.tsx:67`, `brief-html-template.ts:251`).
7. **Warnings:**
   - "For a higher-priced product, we recommend a daily budget of **at least** …" appears whenever the daily figure exceeds $50, whatever the price (`:1427-1439`).
   - Every budget warning is removed for stores with fewer than 20 orders, while the budget stays (`:1655-1667`, `:1749-1751`).
8. **Rendering, where the figure is recomputed.** Each surface derives its own figure:
   | Surface | Daily figure shown |
   |---|---|
   | Brief data (`campaigns/brief.ts:252-352`) | strategy daily × ad sets × goal multiplier; the engine's prose is then rewritten with regular expressions |
   | Plain-text export (`brief.ts:531-576`) | the same, plus "Combined Total Daily" and "Combined Total Test Spend" = local + overseas |
   | Budget planner (`budget-planner.tsx:96-110`) | strategy daily × goal multiplier |
   | Targeting card (`targeting-summary.tsx:139-157`) | the engine's **unadjusted** figure takes precedence. With a non-sales goal it disagrees with the planner and the PDF |
   | PDF (`brief-html-template.ts:205`) | goal-adjusted figure; the "scale" budget is daily × 1.2 (`:1408-1410`) |
   | Plain-text fallback with no budget (`brief.ts:579`) | "Recommended starting budget: **5,000**/day for 14 days" in the store currency |
   - `rescaleDailyBudgetForDuration` (`brief.ts:47`) is exported but never called.
9. **Cost per sale, in the PDF** (`brief-html-template.ts:1411-1416`):
   - **With a recorded unit cost:** "Target ad spend per sale: under *price − unit cost* (keeps each order profitable)".
     - The price is the first variant's.
     - The unit cost is the plain average of the costed variants' costs, with no currency check and no sales weighting (`shopify.ts:727`, `:820`; `shopify-intelligence.ts:625-636`).
   - **Without one:** "under ~35% of piece price".
10. **AI involvement.**
    - The daily figure is passed to the targeting AI (`insights-engine.ts:369`) but never used in its prompt.
    - The budget prose is a template.
    - AI does not compute budget amounts in production.

**Hard-coded values:**
- the 15 USD/day low-data plan;
- the tier bounds and rates (2,000; 10,000; 12%; 7%; caps of 800 and 2,000);
- the 150 starter total;
- the 14-day test;
- the 50% price guardrail and the ×3 premium threshold;
- the fallback price of 25 USD;
- the strategy factors 0.7, 1.0 and 1.4;
- the goal multipliers;
- the overseas $18, $25 and $40;
- the $50 warning threshold;
- the 20-order warning cut-off;
- the 35% target spend per sale;
- the ×1.2 scale budget;
- the 5,000/day fallback.

**What the production engine never uses:** unit cost (except in the PDF line), discounts, refunds, returns, shipping, fulfilment, payment fees, inventory, the product's own sales, campaign results, or any merchant limit.

### Phase 0 findings checked against the code

| Phase 0 finding | Production (`main`) | Staging |
|---|---|---|
| BIZ-01: store revenue sets every product's budget | **Confirmed.** A $78,035/month store gets $142.86/day for every product priced under $285.71 (step 3) | Withdrawn (S0.6): no engine budget |
| BIZ-02: non-monotonic, and warnings contradict it | **Confirmed.** $10,000/month → $57/day; $10,001 → $50/day. An $856 product → $428/day; $860 → $143/day. The "at least" warning fires on price-independent amounts; warnings are stripped below 20 orders | Withdrawn |
| BIZ-03: budgets computed in several places that disagree | **Confirmed.** Six surfaces (step 8). The targeting card and the PDF disagree for any goal other than sales | One `BudgetPlan`, rendered everywhere |
| BIZ-04: overseas budget added to domestic totals | **Confirmed, and wider than reported.** The plain-text export adds "Combined Total Daily" and "Combined Total Test Spend" to **every** brief with an engine budget: its condition (`brief.ts:562`) tests `international_recommended_daily`, which the engine always sets, and never the overseas display rule. The planner and PDF show overseas to non-Tier-1 stores, or Tier-1 stores with overseas orders | Removed |
| BIZ-05: no contribution margin | **Confirmed.** Price − average unit cost, labelled "keeps each order profitable"; else 35% of price | Same price − unit cost figure, now labelled a break-even ceiling on product cost alone; the 35% fallback removed |
| BIZ-06: hard-coded and fabricated fallbacks | **Confirmed:** the 5,000/day fallback, the 25 USD price, and revenue that includes tax and shipping | Fallbacks removed |
| Revenue input excludes refunded orders | **Confirmed** (`financial_status=paid`) | Not used |

### The staging interim (Phase S0.6)

`src/lib/budget-plan.ts`:
- **What it recommends:** nothing (`reason: insufficient_product_evidence`). The merchant types a maximum test budget, and the plan splits it evenly over 7, 14 or 30 days, rounding the daily figure down.
- **The engine's budget block:** `withdrawnEngineBudget`, with no amounts.
- **The PDF:** shows price − recorded unit cost as a "break-even ceiling on product cost alone", or no figure.
- **No verdict.** There are no economics, inventory or portfolio checks. Every product gets the same treatment whatever its margin.

### Reference implementations for comparison

`src/modules/economics/legacy/` holds frozen copies of both engines' formulas:
- the production engine as at main@ad56bfc;
- the S0.6 interim plan.

Each function cites the lines it reproduces. Tests pin the known outputs above. The app never imports these files (a boundary test enforces this). They exist only so the before-and-after comparisons in Task 9 run the old formulas on the same inputs as the new engine, rather than describing them.

## The new engine's design

### Definitions

- **Acquired order.** One order of the product, modelled as containing only that product, at the observed units per order.
  - Other items in a real basket are upside and are not counted.
  - Per-order costs (shipping, fulfilment, the fixed payment fee) are charged in full.
- **Evidence window.**
  - The last 365 days of detailed orders for sales and units, from the 24-month mirror.
  - Refund and return rates use **matured** orders only: orders processed at least `return_maturity_days` ago.
- **Prices.**
  - Current variant prices, weighted by the observed variant mix. Without sales, current prices are weighted equally across active variants.
  - Historical prices are used only to measure the discount rate.
- **Currency.**
  - Everything is computed in the shop's currency.
  - A variant cost recorded in another currency is not converted: it is flagged `UNIT_COST_CURRENCY_MISMATCH`.
  - Campaign spend in another currency is converted at a recorded exchange rate, kept with the result.

### Contribution per acquired order

| Line | Formula | Source |
|---|---|---|
| Gross product revenue | Σ (current variant price × variant share) × units per order | catalog, observed mix |
| − Discounts | gross × discount rate | observed product rate; store rate as a labelled proxy; merchant estimate |
| − Product refunds | (gross − discounts) × refund rate (matured orders, product lines only) | observed; store proxy; merchant estimate |
| + Customer-paid shipping, net of shipping refunds | observed on single-product orders, else allocated from multi-item orders, else **0** (`SHIPPING_REVENUE_UNOBSERVED`) | orders |
| **= Net revenue per order** | Tax is excluded. When prices include tax, the order's tax is allocated to the product line and removed (`TAX_ALLOCATED`) | |
| − Product cost | unit cost × (units per order − units recovered per order). Recovered = refunded units restocked (restock types `RETURN`, `LEGACY_RESTOCK`) or cancelled before shipping (`CANCEL`) | variant unit cost (Shopify), observed restocks |
| − Landed cost not in the unit cost | per unit, or % of unit cost | merchant |
| − Shipping cost | per order (product override, else shop setting) | merchant |
| − Fulfilment cost | per order + per unit | merchant |
| − Payment processing | rate × amount charged (net product + shipping + tax) + fixed fee per order. Shopify keeps processing fees on refunds, so fees apply to the full charge | merchant |
| − Other variable selling fees | % of net revenue (for example Shopify's third-party transaction fee or an app revenue share) | merchant, or explicitly confirmed none |
| − Return handling | returns per order × handling cost per return (including return shipping the merchant pays) | observed return incidence; merchant cost |
| **= Variable costs per order** | | |
| **Contribution before advertising** | net revenue − variable costs | |
| **Contribution margin** | contribution ÷ net revenue | |

**No double counting:**
- A refund reduces revenue once and is never also an expense.
- A refunded unit's product cost is lost only when it is not restocked. That loss appears only through the product-cost line.
- Shipping is charged once per acquired order.
- The fixed payment fee is charged once per order.
- Return handling is charged per return, never per refund line.

Property tests check each of these rules.

### Acquisition metrics

| Metric | Definition |
|---|---|
| Break-even CPA | contribution before advertising per acquired order: what one sale can pay for its acquisition without losing money. Ad platforms count orders when they are placed, so where some orders are never paid (cash on delivery, voided), break-even is contribution × the share of orders paid (`UNPAID_ORDERS_ADJUSTED`) |
| Maximum viable CPA | break-even CPA recomputed with the uncertain inputs at the unfavourable end of their range: the observed refund and return incidence at their 90% upper bounds, the observed restock rate and paid share at their 90% lower bounds (Wilson). The discount rate, a ratio of amounts, is used as measured; proxies and merchant estimates at their stated values. Never above break-even |
| Target CPA | min(break-even CPA × (1 − contribution reserve), maximum viable CPA) |
| Expected CPA | only from measured campaign results (spend ÷ matured attributed conversions), with an interval. Never assumed |
| Break-even ROAS | net revenue per order ÷ break-even CPA = 1 ÷ contribution margin |
| Target ROAS | net revenue per order ÷ target CPA |
| ROAS on the platform's basis | amount charged per order (what the pixel reports as the purchase value) ÷ target CPA, so the target can be compared directly with Meta's reported ROAS. Labelled as such |

**Rounding:**
- Costs are rounded **up**, and ceilings and budgets **down**, to the currency's minor unit. Rounding can therefore never move a recommendation above break-even or a merchant limit.
- Rates are kept to 6 decimal places.

### Inputs, provenance and confidence

**Provenance.** Every input carries one of these states, its source and its freshness:

| State | Meaning |
|---|---|
| `observed` | from the shop's own Shopify data |
| `merchant_entered` | typed by the merchant, with the date |
| `confirmed_none` | the merchant confirmed the cost does not apply |
| `store_proxy` | the store-wide observed rate used for a product without enough history of its own |
| `merchant_estimate` | a rate the merchant expects, used only when neither product nor store history exists |
| `missing` | unknown |

**Essential inputs.** If any of these is `missing`, the verdict is INSUFFICIENT DATA:
- the unit cost of every variant in the mix;
- payment processing;
- the shipping cost of shipped products;
- the fulfilment cost;
- the other selling fees (a value or confirmed none);
- the return handling cost, when any return is observed or expected;
- the discount rate and refund rate, from product, store or merchant evidence.

**Economics confidence** is the weakest link across the inputs:
- **High:**
  - every essential input is `observed`, `merchant_entered` or `confirmed_none`;
  - the merchant inputs are ≤ 180 days old;
  - the discount and refund rates are product-level observations;
  - there are ≥ 30 product orders in 365 days;
  - inventory was read within 48 hours.
- **Medium:** complete, but with at least one store proxy or merchant estimate, 10–29 product orders, merchant inputs older than 180 days, or stale inventory.
- **Low:** complete, but with fewer than 10 product orders.

**Demand and acquisition evidence:**
- **Proven:** ≥ 20 matured attributed conversions for the product in tracked campaigns in the last 90 days.
- **Indicative:** 1–19 matured conversions.
- **Established demand:** no campaign results, but ≥ 10 product orders in the last 180 days.
- **Unproven:** none of the above.

### Verdicts

Evaluated in this order. The first match wins, and every reason found is kept.

| Verdict | Rule | Budget |
|---|---|---|
| BLOCKED | a hard restriction: product not active, gift card, zero price, out of stock everywhere online with overselling off, target market not served by an active market and shipping zone, or the merchant excluded it | zero |
| DO NOT LAUNCH | known revenue − known costs ≤ 0 (missing costs can only lower contribution, so this holds even with gaps); or contribution ≤ 0; or proven acquisition whose CPA lower bound exceeds break-even | zero |
| INSUFFICIENT DATA | an essential input missing or unreliable | withheld: no amounts |
| GO | economics confidence High or Medium; acquisition Proven; expected CPA ≤ target and its 90% upper bound ≤ break-even | controlled test, or a scaling step when a campaign is running |
| PILOT | positive contribution with complete inputs, but acquisition not proven, or expected CPA between target and break-even | small pilot, only within limits the merchant has set |

**Reason codes.** The full, versioned catalogue, with the plain-language text the brief shows, is `src/modules/economics/reasons.ts`. Task 4 added `SHOP_CURRENCY_UNKNOWN`, `PRICE_UNKNOWN`, `UNIT_COST_ZERO`, `LANDED_COST_UNCONFIRMED` and `TAX_RATE_UNKNOWN` to the missing inputs, and further evidence notes. The initial list:
- **Restrictions:** `PRODUCT_NOT_ACTIVE`, `GIFT_CARD`, `ZERO_PRICE`, `OUT_OF_STOCK`, `TARGET_MARKET_NOT_SERVICED`, `MERCHANT_EXCLUDED`.
- **Missing data:**
  - costs: `UNIT_COST_MISSING`, `UNIT_COST_PARTIAL`, `UNIT_COST_CURRENCY_MISMATCH`, `PAYMENT_FEES_MISSING`, `SHIPPING_COST_MISSING`, `FULFILMENT_COST_MISSING`, `SELLING_FEES_UNCONFIRMED`, `RETURN_COST_MISSING`;
  - rates: `DISCOUNT_RATE_UNKNOWN`, `RETURN_RATE_UNVERIFIED`.
- **Economics:** `NEGATIVE_CONTRIBUTION_MARGIN`, `CPA_ABOVE_BREAK_EVEN`, `CPA_ABOVE_TARGET`.
- **Evidence:** `INSUFFICIENT_CONVERSION_EVIDENCE`, `NO_SALES_HISTORY`, `SALES_SAMPLE_SMALL`, `ATTRIBUTION_IMMATURE`, `DISCOUNT_RATE_STORE_PROXY`, `RETURN_RATE_STORE_PROXY`, `RETURN_RATE_MERCHANT_ESTIMATE`, `SHIPPING_REVENUE_UNOBSERVED`, `TAX_ALLOCATED`, `COST_SETTINGS_STALE`.
- **Constraints:**
  - inventory: `INVENTORY_LIMITED`, `INVENTORY_UNTRACKED`, `INVENTORY_OVERSELL_ALLOWED`, `INVENTORY_STALE`;
  - limits: `MERCHANT_LIMIT_BINDING`, `MERCHANT_AUTHORITY_MISSING`, `PORTFOLIO_LIMIT_REACHED`, `POLICY_LIMIT_BINDING`, `BUDGET_BELOW_MINIMUM_TEST`.

### Budget

**Maximum budget** = MIN(merchant limit, inventory limit, portfolio limit, policy limit). The binding constraint is named.

| Constraint | Definition |
|---|---|
| Merchant limit | the merchant's maximum for this test, and the maximum experimental loss (a test that sells nothing loses its whole spend, so the test total never exceeds the loss limit). Without merchant limits no amount is recommended (`MERCHANT_AUTHORITY_MISSING`) |
| Inventory limit | sellable units: Shopify's `available` at active online locations, for tracked variants with overselling off, from Phase 3's `inventory_availability`. Shopify already nets committed, reserved and unavailable stock (damaged, quality control, safety stock) out of `available`, so nothing is subtracted twice. Less the organic sales expected during the test, ÷ units per order × target CPA. Incoming stock is excluded |
| Portfolio limit | the merchant's monthly advertising limit, less existing commitments, allocated across products (below) |
| Policy limit | PILOT: `pilot_conversions` × target CPA. GO: `test_conversions` × target CPA. Scaling: the current daily × (1 + `scale_step`) |

**Outputs:**
- **Initial test budget:** the maximum budget. If it falls below `min_test_conversions` × target CPA, too small to learn anything, it becomes zero (`BUDGET_BELOW_MINIMUM_TEST`).
- **Daily recommendation:** test budget ÷ test duration (7, 14 or 30 days), rounded down.
  - If it exceeds the merchant's daily maximum, the daily maximum is used and the test lengthens, up to 30 days.
- **Ongoing campaign budget:** only for GO, once a running campaign earns a scaling step. Otherwise "decided after the test".
- **Maximum authorised experimental loss:** the merchant's limit, used by the stop rule.

A daily recommendation is not a platform spending guarantee. Meta may under- or over-deliver within a day. A target CPA is not a predicted CPA.

### Portfolio allocation

1. **Available:** the monthly limit, less the next 30 days of existing commitments (a shared campaign budget is counted once).
2. **Candidates:** GO and PILOT products with a positive individual ceiling.
   - A product already in an active campaign is not given a second, independent budget.
3. **Order, fixed and explainable:**
   1. GO before PILOT.
   2. Then by margin of safety: (break-even CPA − expected CPA upper bound) ÷ break-even CPA where measured, else (target CPA ÷ net revenue).
   3. Then by economics confidence.
   4. Then by product ID.
4. **Allocation:** each product receives its full ceiling while it fits.
   - Otherwise it receives what remains, if that is at least its minimum meaningful test; else zero, with `PORTFOLIO_LIMIT_REACHED`.
5. **The invariant:** the sum of allocations never exceeds the available amount. Property tests check it.

### Campaign results and feedback

**Inputs, per tracked campaign and product:**
- daily spend, attributed conversions, conversion value, and clicks where known;
- the attribution setting;
- the source (merchant-entered now; an import later);
- the currency.

Days within `attribution_lag_days` are **immature**. Only matured days are judged.

**Rules, in order:**

| Action | When |
|---|---|
| STOP | cumulative loss (spend − conversions × contribution) has reached the maximum experimental loss |
| REDUCE or PAUSE for inventory | sellable stock cannot cover the orders expected over the next `inventory_cover_days` |
| RECALCULATE | a material change since the recommendation: price or unit cost ±5%, a refund-rate change outside its interval, changed cost settings |
| WAIT | matured spend < 1 × break-even CPA with fewer than `min_judgement_conversions`, or the recent days are immature |
| PAUSE or REVISE | the CPA's 90% **lower** bound exceeds break-even |
| SCALE | ≥ `min_scale_conversions` matured conversions, point CPA ≤ target, and the 90% **upper** bound ≤ break-even. At most `scale_step` per step, at least `scale_interval_days` apart, within every constraint |
| HOLD and OPTIMISE | point CPA between target and break-even, or an interval spanning both |

**Statistics:**
- **The CPA interval** comes from the conversion count. Conversions for a fixed spend are Poisson, so the exact (Garwood) interval on the count gives CPA = spend ÷ count bounds.
- **Zero conversions** are handled the same way: after a spend of 3 × break-even CPA with no sale, a CPA at or below break-even has under 5% probability.
- **Conversion rate** (conversions ÷ clicks) is binomial. It gets a Wilson interval, is reported separately, and is never used as a CPA interval.

### Recording and reproducibility

**Each run records:**
- the evidence snapshot, the merchant inputs and the policy values used;
- the calculation version and the policy version;
- every output, the verdict, the reason codes and each constraint's value.

A test recomputes stored recommendations from their recorded inputs and requires identical outputs.

## Policy defaults (conservative, configurable, for CEO approval)

All values live in `economics_policies`, versioned and documented with their rationale. Recommendations record the version used.

| # | Policy | Default | Why this default |
|---|---|---|---|
| P1 | Contribution reserve | 30% | Keeps 30% of each sale's contribution after advertising. $30 break-even → $21 target |
| P2 | Pilot size | 10 conversions at target CPA | Enough to show whether sales happen at all; not enough to scale on |
| P3 | Controlled test size (GO) | 20 conversions at target CPA | Gives a CPA estimate within roughly ±45% (90%) |
| P4 | Minimum meaningful test | 5 conversions at target CPA | Below this a test cannot distinguish a working product from a failing one |
| P5 | Scaling | +20% per step, at least 3 days apart, ≥ 20 matured conversions | Gradual enough not to reset the platform's learning; reversible |
| P6 | Evidence thresholds | 30 orders (High); 10–29 (Medium); product discount rate from ≥ 10 orders in 180 days; product refund rate from ≥ 20 matured orders; store proxy from ≥ 50 matured orders | Small samples give unstable rates |
| P7 | Return maturity | 60 days | Most refunds arrive within a 30-day return window plus processing |
| P8 | Attribution lag | 7 days | Meta's default 7-day click window |
| P9 | Decision confidence | 90% one-sided | Balances stopping a losing campaign early against cutting a working one |
| P10 | Estimates for missing costs | **Not allowed.** The merchant enters or confirms each cost | No industry average is presented as the merchant's cost |
| P11 | Inventory | incoming excluded; safety stock respected; organic demand reserved for the test | Spending must never sell stock the merchant cannot ship |
| P12 | Acquired-order model | single product; basket upside ignored | The conservative choice for a first order |
| P13 | Lifetime value | not used | Authorisation: first-order economics only |

## Data readiness on staging (checked 2026-11-24, read-only)

| | Dev store | omni-beta |
|---|---|---|
| Currency, plan, taxes included | USD, Basic, no | NGN, Plus, no |
| Variants with unit cost | 0 of 32 | 1,416 of 100,036 (all NGN) |
| Products sold in 365 days | 2 orders | 326 products, **all costed**; 24 with ≥ 30 orders; 1.86 lines per order |
| Discounts, shipping, tax on orders | none | none (orders created through the API) |
| Refunds | none | 166 refunds, 231 lines, all `NO_RESTOCK` |
| Order subtotal = Σ (line price × qty − line discount) | 2 of 2 | 1,665 of 1,665 |

**What this means for testing:**
- Real-data verification can cover product cost, variant mix, refunds and inventory on omni-beta.
- Discounts, shipping, tax, restocked returns and campaign results do not exist on either store. They are covered by labelled synthetic fixtures.

## Tasks

| # | Task | Migration | Depends on |
|---|---|---|---|
| 1 | Audit of both existing engines, frozen reference implementations, this plan | none | — |
| 2 | Policy and merchant inputs: versioned policy, cost settings with per-product overrides, spending authority | 0052 | 1 |
| 3 | Economics evidence in Postgres: per-product sales, variant mix, discounts, refunds, restocks, returns, shipping, tax, inventory, freshness and store proxies | 0053 | 2 |
| 4 | Contribution engine: provenance, contribution per order, break-even, maximum viable and target CPA, ROAS, rounding, currency | none | 3 |
| 5 | Evidence classification, verdicts, reason codes and budget constraints | none | 4 |
| 6 | Portfolio allocation, recorded recommendations and reproducibility | 0054 | 5 |
| 7 | Campaign tracking and feedback: results, attribution maturity, CPA intervals, the action rules | 0055 | 6 |
| 8 | Product integration: briefs, PDF, plain text and planner render the recorded recommendation; settings for costs and limits; AI boundary | none | 6, 7 |
| 9 | Verification, before-and-after comparison, the CEO economics report and the completion report | none | 2–8 |

Each task ships with:
- its migration's `.down.sql`;
- database tests (real Postgres);
- unit tests;
- a results section here.

### Acceptance criteria

**Task 1:**
- Both engines are documented from the code with line references.
- Each Phase 0 finding is checked.
- The reference implementations reproduce the documented outputs in tests ($78,035 → $142.86/day; $10,000 → $57.14 against $10,001 → $50.01; $856 → $428 against $860 → $142.86).
- A boundary test keeps the app from importing them.

**Task 2:**
- Policy rows are versioned, with a documented rationale per key.
- A recommendation can name the policy version it used.
- Merchant cost settings record each value's provenance, author and date.
- `confirmed_none` is distinct from missing.
- Spending authority covers the monthly limit, the per-test maximum, the daily maximum and the maximum experimental loss.
- Writes go through functions only, with the service role only.
- Shop deletion and redaction cover the new tables.

**Task 3:**
- One bounded SQL call returns, per product:
  - orders, units and units per order;
  - the variant mix with current price, unit cost and currency;
  - the discount rate;
  - refund and restock rates over matured orders;
  - return incidence;
  - shipping charged on single-product orders;
  - allocated tax;
  - organic daily sales;
  - online sellable inventory;
  - the freshness of every source;
  - store-level proxies.
- Synthetic fixtures cover discounts, shipping, tax-inclusive prices, restocked returns and cancellations.
- omni-beta figures equal a recomputation from raw orders.

**Task 4:**
- Golden cases include the illustrative $80 product ($72 net revenue, $30 contribution, $30 break-even, $21 target).
- Property tests:
  - no double counting;
  - contribution falls monotonically as any cost rises;
  - target ≤ maximum viable ≤ break-even;
  - rounding never raises a ceiling.
- A missing essential input yields no number.

**Task 5:**
- Scenarios A–F give the expected verdict, reasons and budget.
- Blocked and unviable products get exactly zero.
- Insufficient data gets no amounts.
- No budget exceeds any constraint (property tests).

**Task 6:**
- Scenario G: the portfolio never exceeds the merchant's limit (property tests), and every allocation names its constraint and rank reason.
- Recommendations are stored with their inputs.
- Recomputation from stored inputs is identical.

**Task 7:**
- Each action has tests with immature, mature, zero-conversion, loss-limit, inventory and recalculation cases.
- The CPA and conversion-rate intervals are tested separately.
- A currency conversion is recorded.

**Task 8:**
- Briefs, the PDF, plain text and the planner render one recorded recommendation.
- No surface computes a budget.
- Merchants can enter costs and limits.
- The AI prompt contains no budget figures (boundary test).
- The S0.6 interim is replaced.

**Task 9:**
- Live checks on omni-beta and the dev store.
- The before-and-after comparison runs both old engines and the new one on identical scenarios.
- The CEO section "The Economics Behind Omnitarget's Advertising Recommendations" with defended, illustrative worked examples.
- The completion report.

## Capacity

Recommendations are computed on demand for a brief or a portfolio run, at most 200 products per run. A recorded recommendation is about 2–4 KB, measured in Task 6.

## Task results

### Task 1: audit and reference implementations (2026-11-24; no migration)

Recorded above: "Task 1: how budgets are produced today". The reference implementations and their tests are `src/modules/economics/legacy/`.

### Task 2: policy and merchant inputs (2026-11-24; migration 0052)

**Tables:**
- **`economics_policies`:**
  - versioned;
  - a written version never changes (a trigger refuses it); only its status and approval move;
  - exactly one version is active (unique partial index);
  - every setting is checked for presence and range by `economics_policy_settings_valid`, which also keeps test sizes, confidence thresholds and test lengths in order.
- **Version 1** holds the 32 defaults in "Policy defaults", each with its rationale stored beside it, and `approval = 'pending'` until the CEO decides.
- **`economics_input_keys`:** the catalogue of 17 merchant inputs.
  - Each key records its kind (rate, money or flag), where it may be set (shop, product or both), the states it may take and its range.
  - For example, `expected_*` rates can only be estimates; spending limits can only be entered; `landed_cost_per_unit` only per product.
- **`merchant_economics_inputs`:** one row per value, shop-wide (`product_shopify_id = 0`) or a product override.
  - Each row keeps its state (`merchant_entered`, `confirmed_none`, `merchant_estimate`), its currency for money, who entered it and when.
  - `confirmed_none` must be 0.
  - A missing row is unknown.

**Functions (service role only):**
- `save_economics_inputs` saves and clears in one transaction, all or none.
  - It refuses unknown keys, wrong scopes, wrong states, out-of-range values, non-numbers, money before the shop's currency is known, more than 500 changes or 20,000 rows, and shops not bound to an active workspace.
- `economics_inputs` returns the currency with the shop-wide values and the overrides for the products asked about.
- `economics_policy` returns a version or the active one.
- Shop deletion and redaction (`delete_shop_synced_data`, `shop_synced_row_count`) include the inputs. The policy and catalogue are global.

**Code** (`src/modules/economics/`):
- `policy.ts` checks a version with the database's rules before the engine uses it. The engine carries no defaults of its own.
- `inputs.ts` resolves one product's inputs:
  - its override, else the shop's value, else `missing`, never 0;
  - money entered under a previous shop currency becomes missing (`currency_changed`);
  - values older than `merchant_inputs_stale_days` are marked stale.
- `repository.ts` reads and saves through the functions.

**Tests:**
- `economics-inputs.db.test.mjs` (6):
  - the active version and its rationale;
  - immutability, invalid settings, one active version, approval needing its date;
  - provenance on save, replacement and clearing;
  - every catalogue rule;
  - all-or-none batches;
  - currency and binding requirements;
  - function-only access.
- `commerce.db.test.mjs` now classifies the inputs table as deleted with the shop.
- Unit (`policy.test.ts`, `inputs.test.ts`):
  - the test fixture equals version 1 as the migration writes it;
  - the parser refuses what the database refuses;
  - override precedence, currency change, staleness.

**Staging:** 0052 applied. The active policy has version 1, 32 settings, approval pending. There are 17 input keys. Both test stores' currencies are known (USD, NGN), and no inputs have been entered yet.

### Task 3: economics evidence in Postgres (2026-11-24; migration 0053)

**`product_economics_evidence(shop, products, as_of, sales, discount, maturity and demand windows)`.** One bounded call returns everything the formulas read:
- **Scope:** at most 200 products, at most 250 variants each (sold ones first).
- **Windows:** passed in from the policy, so a recommendation can record and reproduce them.
- **Test orders** are excluded.
- **"Paid"** means money collected: paid, partially refunded or refunded. An order with no financial status counts as **not paid**.

**What it returns per product:**
- **The product:** status, gift card, Collective, published online, when it was read.
- **Variants:** current price, unit cost and its currency, tracking, overselling policy, shipping, and units and orders sold in the window (the variant mix).
- **Sales over paid orders:** orders, units, gross, line discounts, net; orders created but not paid; first and last order; demand-window and 30-day units.
- **The discount window's** gross and discounts.
- **Customer-paid shipping:**
  - summed on orders holding only this product;
  - allocated by line value on orders holding others;
  - always only from orders with no refund, because shipping on a refunded order may have been refunded.
- **Allocated tax:** order tax × line net ÷ (subtotal + shipping).
- **Matured orders only:** refunded amount, refunded units, units restocked by return and by cancellation, orders refunded, returns and returned units.
  - Refund figures are **withheld (null)** while any refund on those orders has unread lines.
  - Return figures are withheld while any return predates Phase 3's fields.
- **Inventory:** Phase 3's `inventory_availability` per variant, without location detail. It is reused, not recreated.

**Also returned:**
- **Store-wide figures** over the same windows, for products without enough history: paid and unpaid orders, tax and its base, discounts, matured totals and refunds, matured orders with a return.
- **Freshness** per domain: the later of the import checkpoint and the reconcile watermark.

**Tests:**
- `economics-evidence.db.test.mjs` (4), on **synthetic fixtures** built to cover what the test stores lack:
  - a discounted single-product order;
  - a partially refunded order with one unit returned and restocked;
  - a two-product order with allocated shipping;
  - an order cancelled and refunded before shipping (restocked by cancellation);
  - an immature refunded order;
  - an unpaid voided order;
  - a test order;
  - an order outside the year;
  - tax on every paid order;
  - an order with no financial status.
- Each aggregate is worked out by hand in the test. Further cases cover withholding, shop isolation, the 200-product bound and access.
- Unit: number normalisation.

**Live, read-only on staging** (`evidence.live.test.ts`). Every figure is recomputed independently in the test from the raw mirror rows (orders, lines, refunds, refund lines, returns, variants, levels, locations):

| Store | Products | Product-orders | Matured | Refunds checked | Variants against Shopify | Mismatches |
|---|---|---|---|---|---|---|
| omni-beta | 27 (25 sold, 2 never sold) | 855 | 707 | ₦18,015,000 | 27 (price and unit cost) | 0 |
| Dev store | 3 | 1 | 1 | none | 5 | 0 |

**Found and fixed:**
- omni-beta's order #1001 has no financial status (Phase 3 found it). The first version counted it as neither paid nor unpaid.
- It now counts as not paid, the conservative choice: its money is not known to have been collected.

**Inventory freshness:**
- omni-beta's inventory checkpoint dates from 2026-11-19, because staging's worker runs only while the development machine does.
- The engine will mark it stale (more than 48 hours old) and cap confidence at Medium, as designed.

### Task 4: contribution engine (2026-11-24; no migration)

**`computeProductEconomics`** (`src/modules/economics/contribution.ts`, calculation version `econ-1.0.0`). It is pure: evidence, the merchant's inputs and a policy version go in, and one product's economics come out.

**What it produces:**
- every line in the contribution table, each with its source (`observed`, `merchant_entered`, `confirmed_none`, `store_proxy`, `merchant_estimate`, `missing`, or `derived` for computed figures and stated conservative assumptions) and a basis in words;
- net revenue, variable costs, contribution and margin;
- the amount charged per order;
- break-even, maximum viable and target CPA;
- break-even, target and platform-basis ROAS.

**How it handles uncertainty:**
- **Rates** come from the product's own history, else the store's (a labelled proxy), else the merchant's estimate, else they are unknown.
- **Withheld refund evidence** is never used. It falls back to the store or merchant figure, with a note.
- **Missing essential inputs:** no contribution and no CPA. An upper bound from what is known is reported instead: known revenue − known costs. Missing costs can only lower it, so a bound ≤ 0 proves the product unviable regardless.
- **Money** is whole minor units (ISO 4217 exponents): revenue rounds down; costs and reductions round up; ceilings round down; no −0.
- **Rates** keep full precision; rounding one first would move a cost by a cent.

**Choices made while building** (documented above):
- the share of orders paid enters break-even (`UNPAID_ORDERS_ADJUSTED`);
- a unit cost of zero on a selling variant counts as unreliable (`UNIT_COST_ZERO`);
- landed costs must be entered or confirmed as already in the unit cost;
- when prices include tax and no order shows how much, the tax is unknown;
- the payment-fee base uses the shipping counted as revenue (shipping on refunded orders is left out), which slightly understates fees on refunded orders.

**Statistics** (`stats.ts`): Wilson score bounds; exact Poisson (Garwood) bounds through the regularised incomplete gamma, for task 7. All are checked against published tables.

**Tests (36 unit):**
- **The golden case**, the illustrative $80 product:
  - gross $80 → discounts $4 → refunds $4 → **net revenue $72**;
  - costs $42 (product $30, shipping $7, fulfilment $2, payment fees $2.20, returns $0.80);
  - **contribution $30**, margin 41.67%;
  - **break-even $30, target $21**, maximum viable $26.11;
  - ROAS 2.40 break-even, 3.43 target, 3.62 on the platform's basis.
- **Each missing or unreliable input** is named and yields no number.
- **Each component counted once:** tax inside prices against on top; shipping revenue against cost; restocks recover cost while refunds reduce revenue once; unpaid orders; negative contribution.
- **Properties over 500 seeded random products:**
  - lines add up exactly;
  - target ≤ maximum viable ≤ break-even ≤ contribution;
  - contribution never rises when any of 13 costs, rates or reductions rises;
  - refunds never touch product cost, and restocks never touch revenue.
