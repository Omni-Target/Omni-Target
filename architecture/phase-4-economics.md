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

**Rules, in order** (as built in Task 7). Thresholds are in the shop's currency; each day is converted at the rate recorded beside it.

| Action | When | Next daily budget |
|---|---|---|
| NOT RUNNING | the campaign is planned, paused or ended | unchanged |
| STOP | cumulative loss (all spend − all sales × break-even) has reached the authorised maximum loss (`LOSS_LIMIT_REACHED`) | 0 |
| PAUSE or REVISE | a product in the campaign is now blocked or has negative contribution | 0 |
| RECALCULATE | price, unit cost or break-even moved more than the material-change threshold since the authorising recommendation, or an input is now missing (`ECONOMICS_CHANGED`) | unchanged until recalculated |
| PAUSE for inventory | no stock is left for advertising after the organic reserve | 0 |
| REDUCE for inventory | the current budget would bring more orders over `inventory_cover_days` than the stock left for ads | stock ÷ units per order × cost per sale ÷ cover days |
| WAIT | no matured day yet (`ATTRIBUTION_IMMATURE`), or matured spend < `min_judgement_spend_multiple` × break-even with fewer than `min_scale_conversions` sales | unchanged |
| PAUSE or REVISE | the CPA's 90% **lower** bound exceeds break-even (`CPA_ABOVE_BREAK_EVEN`); with no sales this happens once spend exceeds 2.30 × break-even | 0 |
| SCALE | ≥ `min_scale_conversions` matured sales, point CPA ≤ target, 90% **upper** bound ≤ break-even, and `scale_interval_days` since the last increase | × (1 + `scale_step`), capped by the merchant's daily limit and the stock |
| HOLD and OPTIMISE | point CPA above target, or no sale yet but not confidently above break-even | unchanged |
| CONTINUE | on target but too few sales to scale, recently scaled, or capped by the daily limit or stock | unchanged |

A campaign covering several products is judged against the least forgiving product's break-even and target. Only single-product campaigns count as a product's own acquisition evidence: a shared campaign's sales cannot be attributed to one product.

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
| P1 | Contribution reserve | 30% (provisional) | Keeps 30% of each sale's contribution after advertising, **towards fixed operating costs and profit** (it is not pure profit: rent, salaries and software are paid from it). $30 break-even → $21 target. Effect of changing it: see "Finalisation" |
| P2 | Pilot size | 10 conversions at target CPA | Enough to show whether sales happen at all; not enough to scale on |
| P3 | Controlled test size (GO) | 20 conversions at target CPA | At 20 sales the measured CPA's range runs from 26% below to 38% above it (80% two-sided, each side 90%). *Corrected in the finalisation: this row first said "roughly ±45%".* |
| P4 | Minimum meaningful test | 5 conversions at target CPA | Below this a test cannot distinguish a working product from a failing one |
| P5 | Scaling | +20% per step, at least 3 days apart, ≥ 20 matured conversions | Gradual enough not to reset the platform's learning; reversible |
| P6 | Evidence thresholds | 30 orders (High); 10–29 (Medium); product discount rate from ≥ 10 orders in 180 days; product refund rate from ≥ 20 matured orders; store proxy from ≥ 50 matured orders | Small samples give unstable rates |
| P7 | Return maturity | 60 days; **version 2:** the store's own 90th-percentile refund lag, kept within 30–120 days, once it has ≥ 20 refunds | Most refunds arrive within a 30-day return window plus processing; a store's own timing is better evidence than a fixed default |
| P8 | Attribution lag | 7 days, or the campaign's own attribution setting (version 2 reads it from the campaign) | Meta's default 7-day click window |
| P9 | Decision confidence | 90% one-sided | Balances stopping a losing campaign early against cutting a working one |
| P10 | Estimates for missing costs | **Not allowed.** The merchant enters or confirms each cost. Expected discount, refund and return *rates* may be merchant estimates for a product with no history, labelled as such; **version 2** stresses them ×1.5 for the maximum viable CPA | No industry average is presented as the merchant's cost |
| P11 | Inventory | incoming excluded; safety stock respected; organic demand reserved for the test | Spending must never sell stock the merchant cannot ship |
| P12 | Acquired-order model | single product; basket upside ignored | The conservative choice for a first order |
| P13 | Lifetime value | not used | Authorisation: first-order economics only |
| P14 | Estimate downside (version 2) | ×1.5 | A merchant's estimate or a store-wide stand-in is not the product's own evidence. Paid share is stressed by 1.5× its shortfall |
| P15 | Micro-pilot (version 2) | at least 1 sale at target CPA, when the limit is below the 5-sale minimum | A diagnostic: traffic, engagement and first sales. Never GO, never scaled, funded only after every full test |
| P16 | Refund maturity bounds (version 2) | 30–120 days, from ≥ 20 refunds | See P7 |
| P17 | Purchase counted (version 2, merchant input) | unconfirmed → the lower break-even | Omnitarget's Conversions API counts a purchase when paid; a browser pixel counts it when placed |
| P18 | Rate bounds (version 2) | exact (Clopper–Pearson), one-sided 90% | Wilson bounds measured as low as 81% coverage at 20 orders |

**Status:** version 1 (0052) is retired. Version 2 (0056) is active and **pending approval**. Recommendations made under version 1 keep `econ-1.0.0` and recompute unchanged.

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
| F | Finalisation: cash on delivery, confirmed zero costs, per-variant landed cost, estimate downside, micro-pilot, statistics audit, policy version 2 | 0056 | 1–9 |

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

### Task 5: verdicts, confidence and budget (2026-11-24; no migration)

**`recommendProduct`** (`src/modules/economics/recommend.ts`) is pure. It takes Task 4's economics, plus:
- the merchant's limits;
- stock;
- the portfolio's allowance (Task 6);
- campaign results (Task 7);
- whether the target market is served.

It returns the verdict, the reasons, the notes, the confidence and the budget.

**Confidence.** Each class records why.
- **Economics:**
  - low below 10 product orders;
  - high with ≥ 30 orders and nothing downgrading;
  - medium otherwise.
  - Downgrades: a store proxy or merchant estimate, stale cost inputs, stale stock, an unobserved paid share.
- **Acquisition:**
  - proven: ≥ 20 matured campaign sales;
  - indicative: 1–19;
  - established demand: ≥ 10 orders in 180 days;
  - unproven otherwise.
- **Overall:**
  - high only when economics are high and acquisition is proven;
  - medium when economics are at least medium and there is some acquisition or demand evidence;
  - low otherwise.

**Verdicts, in order:**
1. **BLOCKED:** restrictions (not active, gift card, zero price, out of stock everywhere online with overselling off, market not served, excluded by the merchant).
2. **DO NOT LAUNCH:** contribution ≤ 0, or the upper bound ≤ 0 even with inputs missing, or a proven CPA whose lower bound exceeds break-even.
3. **INSUFFICIENT DATA:** missing inputs.
4. **GO:** proven acquisition with economics at least medium, CPA ≤ target and its upper bound ≤ break-even.
5. **PILOT:** otherwise, with `CPA_ABOVE_TARGET` or `INSUFFICIENT_CONVERSION_EVIDENCE` and `NO_SALES_HISTORY`.

**Budget** = the smallest of these ceilings, with the binding one named:
- **Merchant:** the test limit and the loss limit.
- **Inventory:** online stock, less organic demand reserved for the test (the higher of the 30-day and 180-day rates), in whole orders at the target CPA.
  - Untracked stock is not capped.
  - Stock that Shopify tracks but nobody has read counts as none (`INVENTORY_UNKNOWN`).
- **Portfolio.**
- **Policy:** a pilot of 10 sales, or a controlled test of 20, at the target CPA.

**Budget outcomes:**
- **Blocked and unviable products:** exactly 0.
- **Missing data:** no amounts.
- **No merchant limit:** no amount, but the other ceilings are shown (`awaiting_authority`).
- **Below the minimum test** (5 sales at the target CPA): 0.
- **When the daily limit binds:** the test lengthens in whole days up to 30, and the test budget is exactly daily × days.

**Tests (15, plus 2 properties over 1,000 random products):**

| Scenario | Verdict | Budget (illustrative) |
|---|---|---|
| A: healthy, 40 sales at $17 | GO, confidence high | $420 controlled test (20 × $21, policy binding), $30/day × 14, loss limit $600 |
| B: unit cost missing | INSUFFICIENT DATA (`UNIT_COST_MISSING`) | no amounts |
| C: costs above revenue | DO NOT LAUNCH (`NEGATIVE_CONTRIBUTION_MARGIN`) | $0 |
| D: 20 units in stock | GO | $252: (20 − 8 reserved) × $21, inventory binding |
| E: new, no sales, estimates only | PILOT, confidence low | $150, the merchant's own limit, $10.71/day |
| F: 30 sales at $25 | PILOT (`CPA_ABOVE_TARGET`) | $210 pilot |

**Further cases:**
- every restriction gives exactly 0;
- a proven CPA above break-even;
- unviable economics settled despite a missing cost;
- a missing merchant limit;
- the daily limit stretching a test (21 days) and capping it (30 days, $300);
- below the minimum test;
- the portfolio binding;
- stale, untracked and unknown stock.

**Properties:**
- zero for blocked and unviable products, no amounts for missing data;
- never above any ceiling, the merchant's test, loss or daily limits;
- daily × days ≤ the test budget;
- every recommended test is at least the minimum;
- GO only with proven acquisition and economics at least medium;
- all five verdicts occur.

**The property tests found two faults, both fixed before merging:**
- a test stretched by the daily limit could fall below the minimum;
- rounding the test length up let daily × days exceed the test budget.

### Task 6: portfolio allocation, recorded runs and reproducibility (2026-11-24; migration 0054)

**Allocation** (`portfolio.ts`) is a fixed, explainable order, not a score:
1. **Available:** the monthly limit, less the period's commitments. A campaign shared by several products is counted once.
2. **Candidates:** GO and PILOT products with a recommended test. A product already in an active campaign gets no second budget (`ALREADY_IN_ACTIVE_CAMPAIGN`).
3. **Order:**
   1. GO before PILOT.
   2. Then margin of safety: (break-even − measured CPA upper bound) ÷ break-even where proven, else target CPA ÷ net revenue.
   3. Then economics confidence.
   4. Then product ID.
4. **Allocation:** each product gets its full test budget while it fits. Otherwise it gets what remains, if that is still a meaningful test (5 sales at its target CPA). Otherwise it gets nothing (`PORTFOLIO_LIMIT_REACHED`).
5. **Explanation:** each allocation records its rank and the basis of its rank in words.

**The run** (`run.ts`) works in two passes:
1. Each product's own recommendation.
2. The allocation, then each candidate again with its allocation as its portfolio ceiling, so the final budgets, daily amounts and test lengths are consistent with it.

In ties the portfolio is named as binding only when it actually cut the budget.

**Recording (0054):**
- **`economics_runs`:** when, as-of time, calculation and policy versions (a foreign key to the policy), trigger, requester, the allocation, a summary.
- **`product_recommendations`:**
  - verdict, reasons and the headline amounts as columns;
  - the **complete arguments** the engine received (≤ 256 KB) and its **complete output** (≤ 128 KB).
- **The table itself refuses** a blocked or do-not-launch row with any amount, and an insufficient-data row with one.
- **Writes** go through `record_economics_run` only, all or none, for shops bound to an active workspace.
- **Reads:** `economics_run` (for audit and recomputation) and `latest_product_recommendations`.
- **Deletion:** with the shop's data; nothing is pruned.

**Service** (`service.ts`, server-only): reads the active policy, the merchant's inputs and the evidence; runs; records the run with the versions used.

**Tests:**
- **Unit, scenario G:**
  - six products and a $1,000 limit with a $300 campaign shared by two products;
  - $700 available: product 1 gets $420 in full; product 2 gets the $280 left (partial, still above its $105 minimum); products 3 and 4 get nothing (`PORTFOLIO_LIMIT_REACHED`);
  - the funded product gets no second budget, and the insufficient-data product is not a candidate;
  - final budgets re-sized: product 2 runs $280 at $20 a day.
- **Unit, reproducibility:** every recorded recommendation, round-tripped through JSON, recomputes identically.
- **Unit, properties over 300 random portfolios:**
  - the total never exceeds the limit less commitments;
  - funded products get nothing new;
  - everything recomputes.
- **Database** (`economics-runs.db.test.mjs`, 4):
  - recording and reading back;
  - latest per product;
  - the table's zero and no-amount rules, with all-or-none recording;
  - version and policy checks, and binding;
  - isolation between shops, cascade, function-only access.
- **Commerce classification:** both tables are deleted with the shop.
- **Full database suite:** 262 tests.

**Staging:** 0054 applied.

### Task 7: campaign tracking and feedback (2026-11-24; migration 0055)

**Tables (0055):**
- **`ad_campaigns`:** the shop's own products (1–50), status, ad-account currency, daily budget, the authorised test budget and loss limit in the shop's currency, and the authorising recommendation run.
- **`ad_campaign_results`:** per day, spend, conversions, value, clicks and impressions, with the **exchange rate to the shop's currency and its source**. A same-currency campaign must use a rate of 1. Future days are refused.

**Rules for writing and reading:**
- Writes go through `save_ad_campaign` and `save_ad_campaign_results` (up to 400 days, all or none) for shops bound to an active workspace.
- Reads go through `ad_campaigns_with_results`.
- Everything is deleted with the shop's data.
- **Omnitarget publishes nothing and spends nothing:** results are entered by the merchant now, and an import can follow.

**The engine** (`feedback.ts`):
- **`measureCampaign`:**
  - matured days only;
  - spend converted at each day's recorded rate;
  - CPA with **exact Poisson (Garwood) bounds**;
  - the conversion rate with its own **Wilson** bounds, never used as a CPA interval.
- **`evaluateCampaign`:** the actions in the table above.
- **`acquisitionFromCampaigns`:** single-product campaigns over the acquisition window feed each product's acquisition evidence.
- **`commitmentsFromCampaigns`:** what running and planned campaigns will still spend in the period, the lesser of the authorised budget left and daily × period.
  - A commitment that cannot be valued (a foreign currency with no recorded rate and no authorised budget) leaves **nothing** to allocate (`COMMITMENTS_UNKNOWN`). It is never assumed small.

**Service:**
- Runs now read tracked campaigns: their results become acquisition evidence and their remaining spend becomes commitments.
- `evaluateShopCampaigns` records a fresh check run and judges each active campaign against it and against the run that authorised it.

**Tests:**
- **Unit (14)**, each worked out in the test:
  - matured-only measurement;
  - Poisson against Wilson;
  - currency conversion with the rates listed;
  - STOP ($210 loss against a $200 limit);
  - PAUSE for an unviable product;
  - RECALCULATE (price +12.5%);
  - PAUSE and REDUCE for stock ($50 → $36 a day);
  - WAIT, immature and thin;
  - PAUSE with no sale ($75 spent: lowest plausible CPA $32.57 > $30), not yet at $60;
  - SCALE ($34 → $40.80), blocked by the interval and by the daily limit;
  - HOLD at $25;
  - CONTINUE at $17 with 12 sales;
  - single-product acquisition evidence;
  - commitments, including the unvaluable case.
- **Database** (`campaign-tracking.db.test.mjs`, 3):
  - saving and reading, replacing days, updates;
  - negative spend, future days, zero rates, empty batches;
  - the same-currency rate;
  - the shop's own products and runs;
  - isolation and access.
- **Commerce classification:** both tables are deleted with the shop.
- **Full database suite:** 265 tests.

**Staging:** 0055 applied.

### Task 8: product integration (2026-11-24; no migration)

**One source for every budget figure:**
- A brief linked to a product stores a bounded **snapshot** of the engine's recorded recommendation (`src/lib/brief-economics.ts`, built by `snapshot.ts`). It holds the run ID, calculation and policy versions, verdict, reasons and notes with their text, confidence, the per-order lines and figures, and the budget.
- `describeBriefEconomics` is the only wording for it. The **brief view, budget planner, PDF and plain-text export** all render it.
- Money is shown in each currency's own minor unit and never rounded up. (The shared formatter rounds naira to whole units, which could have shown a ceiling above the computed one.)
- **Unavailable snapshots** say why (store not connected, product not identified, product not in the synced data, currency unknown, engine error) and carry no amounts.
- **Briefs saved before Phase 4** keep their S0.6 plan unchanged.

**Brief flow:**
- **Generation** runs and records the engine for the matched product **after every AI call**, stores `productShopifyId` and the snapshot, and never blocks or fabricates if the economics fail.
- **Recalculation** (`POST /api/economics/brief`, rate-limited) runs when the merchant changes the maximum for this test (saved as the product's own `ad_test_limit`) or the test length, so the planner shows the engine's new answer.
- **Saving the brief** (`PUT /api/campaigns/[id]`) recalculates on the server again. The product comes from the saved brief, never the request, and client-sent figures are never stored.

**Merchant inputs:**
- **Settings** has a "Costs and advertising limits" form: costs per order, expected rates (labelled estimates) and advertising limits.
- A blank field clears the value and makes it unknown; "Doesn't apply" is an explicit zero.
- It saves through `GET` / `PUT /api/economics/inputs` (rate-limited, workspace-scoped), and the database validates again.
- The page reads the stored values on the server, so the form needs no client-side effect.

**PDF route:** the payload's `budget_economics` is size-bounded in the schema. The template reads it only through the strict parser and escapes every value.

**Boundary tests** (`src/platform/boundaries.test.ts`):
- No page, component, route or library imports the computing modules; only `src/modules/economics/` does.
- The economics module never imports the AI SDK.
- The only AI-calling file that imports the engine is the brief route, and there the engine call comes after the last model call.

**Tests:**
- **Snapshot and wording (6):** engine figures copied and round-tripped; strict parsing (tampered numbers and codes dropped); GO, insufficient data, do not launch, awaiting authority and unavailable wording; plain text; floor-only money.
- **Brief route (3 new):** server recalculation with the saved product and the merchant's limit, ignoring a client-sent snapshot, product and plan; limit unchanged, cleared or invalid; the S0.6 path kept for older briefs.
- **Boundaries (3 new).**
- **Full unit suite:** 1,058 tests.
- **Production build:** succeeds.

### Task 9: verification, comparison and reports (2026-11-24; no migration)

**Before and after** (`comparison.test.ts`; every figure is computed by the code and asserted).
- **Setup:** identical illustrative products through the production engine (frozen copy of main@ad56bfc), the staging interim and the new engine.
- **The store:** $78,035 of revenue in 30 days and 2,000 orders.
- **The merchant's limits:** $1,000 per test, $600 maximum loss.

| | Production engine | Staging interim | New engine |
|---|---|---|---|
| A healthy, proven | $143/day ($2,002 per 14 days); PDF: under $50 per sale "keeps each order profitable" | $71.42/day, no judgement | **GO**: $420 test, $30/day (break-even $30, target $21) |
| B unit cost missing | $143/day; PDF: ~$28 (35% of price) | $71.42/day | **INSUFFICIENT DATA**: no amounts |
| C negative contribution | $143/day; PDF: under $10 "keeps each order profitable" | $71.42/day | **DO NOT LAUNCH**: $0 (−$10 per order) |
| D 20 units in stock | $143/day | $71.42/day | **GO**: $252 (inventory-bound), $18/day |
| E new product | $143/day | $71.42/day | **PILOT**: $210, $15/day, confidence low |
| F CPA $25 | $143/day | $71.42/day | **PILOT**: $210 (`CPA_ABOVE_TARGET`) |
| Total over 14 days | **$12,012** | $6,000 (the cap, six times) | **$1,092** |

**What the comparison shows:**
- The production engine also adds $25/day of overseas spend in its plain-text total (BIZ-04).
- A $5,000 store gets $43/day for the same product, because store revenue drives it. The new engine's answer does not depend on store revenue.
- **Scenario G:** four eligible products under a $1,000 monthly limit get $420, $420, $160 and $0. The production engine would give each $2,002 over 14 days ($8,008), with no portfolio limit.

**Live on staging (read-write only on the test stores).**

**omni-beta:**
- **Inputs:** labelled synthetic merchant inputs (₦), proportionate to its catalog.
- **Run:** the engine recorded 27 real products.
- **Reproducibility:** all 27 recommendations recompute identically from their stored inputs.
- **Hand check:** the top product's contribution matches a hand calculation from its evidence to ₦0.02.
- **Results:**
  - 1 GO, 25 PILOT, 1 DO NOT LAUNCH (a ₦149.99 product cannot carry ₦3,000 of shipping and fulfilment: −₦3,009 per order);
  - the ₦20,000,000 monthly limit is exactly allocated (18 full, 1 partial, 4 `PORTFOLIO_LIMIT_REACHED`);
  - 3 products get ₦0 because stock cannot support a minimum test.
- **Campaign chain:** a synthetic single-product campaign (USD, converted at a recorded rate) gives SCALE ($20 → $24/day), and its results make the product GO: a ₦2,000,000 controlled test, capped by the merchant's loss limit.

**Dev store:**
- No costs are entered, so all products are INSUFFICIENT DATA (eight missing inputs named) or BLOCKED (one inactive product). There are no amounts anywhere.

**Evidence check, re-run:**
- omni-beta: 27 products, 853 product-orders, 706 matured, ₦18,015,000 refunds, 27 variants against Shopify: 0 mismatches.
- Dev store: 0 mismatches.

**Found and fixed during the live run:**
1. **Running campaigns lost their stock figures.** A product in a running campaign gets no second budget, and its zeroed budget dropped its stock facts, so the campaign check wrongly said PAUSE for inventory.
   - Stock facts are now computed independently of the verdict and kept on every budget.
   - A regression test covers it.
2. **A determinism fault.** With no organic demand, the reserve was −0, which does not survive JSON storage unchanged, so a stored recommendation did not recompute identically.
   - Fixed, with a round-trip test.

**Capacity:** a recorded recommendation stores about 2.7 KB of inputs and 2.3 KB of outputs (≈ 7 KB per product with indexes). A 200-product portfolio run is ≈ 1.4 MB.

**Final results:**

| Check | Result |
|---|---|
| Unit tests | 1,065 passing (economics module 84) |
| Database tests (real Postgres) | 265 passing |
| Live checks (staging) | evidence ×2, engine ×2: passing |
| Type check, lint (src, supabase), production build | clean (pre-existing warnings only) |
| Migrations 0052–0055 | applied to staging; each with a tested `.down.sql` |

## Finalisation (2026-11-25; migration 0056, policy version 2)

Requested after the Phase 4 report. Version 2 is **active and pending approval**. Every version-2 behaviour is gated on the policy, so a version-1 recommendation recomputes exactly as recorded (`econ-1.0.0`); version 2 records `econ-1.1.0`.

### 1A. Cash on delivery and the Purchase event

**Where Purchase events come from:**
- **Omnitarget's Conversions API:**
  - sends `Purchase` only on Shopify's `orders/paid` webhook (`src/app/api/shopify/webhook/route.ts`, `forwardPurchaseToMeta`, line 188);
  - `event_id` is the Shopify order ID, so Meta receives it once per order (0015);
  - value is `total_price`;
  - the topic is registered at install (`auth/shopify/callback`) and checked daily (`cron/ensure-webhooks`);
  - **an unpaid cash-on-delivery order sends nothing.**
- **Omnitarget has no browser pixel.**
  - A merchant's own pixel, through Shopify's Meta channel, fires at checkout completion, which a cash-on-delivery order reaches when placed and unpaid.
  - Omnitarget cannot see which the merchant uses, so it asks (`purchase_event_basis`: placed or paid).

**The four order states, measured on matured orders by `product_economics_evidence`:**
- **Placed:** every order.
- **Paid:** financial status paid, partially refunded or refunded.
- **Shipped but never paid:** a failed delivery (fulfilment status fulfilled, partial or restocked).
- **Unpaid and never shipped:** cancelled before shipping. It costs nothing and earns nothing.

**Break-even**, where C = contribution per paid order, p = paid share, f = failed-delivery share, and L = outbound shipping + fulfilment + return handling, the product coming back:

| Purchase counted | Break-even per purchase counted | Break-even per paid order |
|---|---|---|
| when paid | C − (f / p) · L | the same |
| when placed | p · C − f · L | C − (f / p) · L |
| unconfirmed | the lower of the two, with `PURCHASE_EVENT_BASIS_UNCONFIRMED` | C − (f / p) · L |

- Version 1 multiplied by the paid share whatever counted the purchase. Version 2 does not reduce break-even for an event that is never sent.
- A failed delivery is counted once, as a cost per failure; its order is not also counted as a refund.
- Return handling is required when failed deliveries exist (`RETURN_COST_MISSING`).
- **Worked case** (`finalisation.test.ts`): $30 contribution; 100 orders placed, 80 paid, 15 refused at the door; $25 per failed delivery.
  - Counted when paid: $25.31.
  - Counted when placed: $20.25 per purchase counted, still $25.31 per paid order.
  - Version 1 gave $24.

**Two CPAs, kept apart:**
- Campaign feedback shows the ad-reported CPA against break-even per purchase counted.
- Separately, it shows the **cost per order actually paid** against break-even per paid order:
  - counted when placed: the reported CPA ÷ the paid share;
  - unconfirmed: shown as unknown, since the engine already judges on the lower break-even.

**Not verified [V]:** whether Meta deduplicates a merchant pixel's checkout Purchase against Omnitarget's paid-order event for the same order. They use different event IDs. If both run on one pixel, Meta's purchase count can be inflated and the reported CPA understated. Until verified, a merchant using both should choose one; this is a Phase 5 or 7 reconciliation item.

### 1B. Zero unit cost

- A zero Shopify unit cost stays `UNIT_COST_ZERO` (missing) until the merchant confirms it.
- **Confirmation:**
  - recorded per variant (`unit_cost_zero_confirmed`, variant scope) or per product, with `entered_by` and `entered_at`;
  - the planner's button confirms exactly the variants whose cost is zero now;
  - a new zero-cost variant, or a cost entered later, is not covered;
  - the database checks the product is the shop's and the variant is the product's.
- A confirmed zero shows as `UNIT_COST_ZERO_CONFIRMED`. Missing is never treated as free.

### 1C. Landed costs

- Either a rate of unit cost (`landed_cost_rate`) or an amount per unit (`landed_cost_per_unit`, now per variant or per product), or confirmed as already in the unit cost (`confirmed_none`, "Already in unit cost" in settings).
- Allocation:
  - each variant uses its own per-unit amount, else the product's, else the rate × that variant's cost;
  - the result is weighted by the variant mix and multiplied by units per order;
  - one source per unit, so it is never counted twice.
- One variant set and another unknown, with no rate: `LANDED_COST_UNCONFIRMED`.

### 1D. Estimates

- **Essential costs are never estimated:**
  - unit cost;
  - payment fees;
  - shipping;
  - fulfilment;
  - return handling.
- **Only rates may be estimated** (expected discount, refund and return), and only when the product has no history. They are labelled `merchant_estimate`.
- **Version 2 downside:**
  - estimates and store-wide stand-ins are stressed ×1.5 (paid share by 1.5× its shortfall) for the maximum viable CPA, noted `ESTIMATE_DOWNSIDE_APPLIED`;
  - the new product in scenario E: maximum viable $30 → $25.80.
- **A product without its own evidence stays PILOT at most:** GO needs proven acquisition (≥ 20 matured conversions from a controlled test).

### 1E. The reserve

The 30% reserve is provisional. It is contribution **towards fixed operating costs and profit**, not profit. The wording is fixed in the policy rationale, the brief and the PDF. Effect on the $80 product, from the engine (`finalisation.test.ts`):

| Reserve | Break-even | Target CPA | Kept per sale at target | GO test (20 sales) | Pilot (10 sales) |
|---|---|---|---|---|---|
| 20% | $30 | $24 | $6 | $480 | $240 |
| **30%** | $30 | **$21** | $9 | $420 | $210 |
| 40% | $30 | $18 | $12 | $360 | $180 |

- **A higher reserve** lowers the target, so fewer products qualify and tests are smaller.
- **Scaling** requires the measured CPA's upper bound under break-even. At 20 sales that means a CPA at most about 72% of break-even, which is consistent with a 30% reserve.

### 2. Test sizes

**Width of the CPA range for a given number of sales** (80% two-sided, each side 90%, exact Poisson):

| Sales | 1 | 3 | 5 | 10 | 20 | 40 | 100 |
|---|---|---|---|---|---|---|---|
| Below | −74% | −55% | −46% | −35% | −26% | −19% | −12% |
| Above | +849% | +172% | +106% | +61% | +38% | +24% | +14% |

- **Pilot of 10:** enough to reject a product far above break-even, not enough to scale.
- **Controlled test of 20:** enough to scale only a clearly profitable product.
- **Minimum of 5:** detects gross failure only.
- **Micro-pilot (version 2):**
  - below the 5-sale minimum but at least one sale at target;
  - a labelled **diagnostic** (`MICRO_PILOT_DIAGNOSTIC`, campaign purpose `diagnostic`);
  - its results never make acquisition "proven", never give GO and never scale;
  - the portfolio funds it only after every full test (found live on staging, fixed).
- **Scaling** (+20%, at least 3 days apart, at least 20 matured sales) is unchanged.

**Where the defaults should change.** These are proposals for a later policy version, **not implemented**:

| Factor | Effect | Proposal |
|---|---|---|
| Category: high-return (apparel, footwear) | Refunds arrive later and more often | Already measured: the store's own refund timing sets maturity (version 2), and observed rates are stressed by exact bounds |
| Category: high price or long consideration | Each sale costs more, so 20 sales take longer | Keep 20 sales and allow a longer test (`max_test_days` 30 → 45), rather than fewer sales |
| Return policy longer than 30 days | Refunds can arrive after the default maturity | Until the store has 20 refunds, set maturity from a merchant-entered return window + 14 days |
| Channel | Attribution windows differ by platform | Already handled: the attribution wait comes from the campaign's setting. Channel-specific sizes belong to Phase 5 (channel fit) |
| Sample size | See the table above | No change: 5 / 10 / 20 sit where the range narrows enough to stop, pilot and scale respectively |

### 3. Statistics audit

All checks are in `finalisation-statistics.test.ts`:
- coverage is computed **exactly** by enumerating the binomial or Poisson distribution;
- campaign rules are simulated with a seeded generator (3,000 runs per case);
- "90%" is **one-sided** for every decision.

**Worst-plausible CPA:**
- Lowest = spend ÷ Garwood upper count; highest = spend ÷ Garwood lower count.
- Each holds at least 90% at every expected count (checked from λ = 0.2 to 160).
- **Never derived from the conversion rate.** The conversion rate's Wilson interval is shown separately and is ignored by the CPA rules (tested).

**High-end refund, return, paid-share and failed-delivery bounds:**
- **Finding:** version 1's one-sided Wilson bounds do **not** hold 90%. Coverage was 81% at 20 orders with a true rate of 8%, and 86–88% is common.
- **Fix:** version 2 uses exact Clopper–Pearson bounds, which hold at least 90% at every size and rate checked (10–200 orders, 1–50%).
- Example: nothing refunded in 20 orders gives an upper bound of 10.9%.

**The no-sale rule:**
- With no sales, the lowest plausible CPA is spend ÷ 2.3026. The campaign is paused once spend passes 2.3026 × break-even.
- A campaign truly at break-even shows no sale that long only 10.0% of the time (exact).

**The campaign rules under daily checks** ($80 product, $34/day, rules checked every day from day 8 to day 35; the first pause or scale ends the run):

| True CPA | $17 | $21 (target) | $25 | $30 (break-even) | $36 | $45 |
|---|---|---|---|---|---|---|
| Paused | 0.7% | 2.6% | 10.5% | 28.7% | 57.6% | 87.9% |
| Scaled | 96.9% | 72.0% | 34.7% | 9.4% | 1.8% | 0.07% |

- **A single check** holds the stated 10%: at 14 matured days, a break-even campaign is paused at most 10% of the time (exact).
- **Repeated daily checks raise the pause rate at exactly break-even to 29%.** Pausing a campaign that earns nothing costs nothing. The rate that matters, pausing a profitable campaign at target, is 2.6%.
- **Scaling a campaign that is not profitable:** 9.4% at exactly break-even, 1.8% at 20% above. A scaled campaign remains under every rule, including the loss limit.
- **Never scales:**
  - on fewer than 20 matured sales;
  - on immature days;
  - from a diagnostic campaign.

  The simulation confirmed none of these in 18,500 runs. Insufficient evidence gives WAIT, HOLD or CONTINUE.

**Timing:**
- **Attribution:** the wait comes from the campaign's own setting ("7d_click_1d_view" → 7, "1d_click" → 1, "28d_click" → 28).
- **Refund maturity:** from the store's own refunds. On omni-beta, 79 refunds have a median lag of 10.2 days and a 90th percentile of 16.2 days, so maturity is 30 days (the minimum), against 60 under version 1.

### 4. Portfolio and currency (verified by tests)

| Requirement | Where verified |
|---|---|
| Shared campaigns counted once | `portfolio.test.ts` (one $300 commitment for two products); shared campaigns are never one product's evidence (`feedback.test.ts`) |
| Existing spend incorporated | commitments = what running campaigns will still spend (`feedback.test.ts`), deducted before allocation |
| Never above the monthly limit | 300 random portfolios (`portfolio.test.ts`); live: ₦20,000,000 allocated exactly |
| Unvalued foreign-currency spend blocks allocation | `COMMITMENTS_UNKNOWN`, nothing allocated (`feedback.test.ts`) |
| Exchange rates with source, timestamp and pair | 0056: `fx_from`, `fx_to`, `fx_as_of` required and not in the future (`campaign-tracking.db.test.mjs`); each rate listed with its pair and time (`finalisation.test.ts`); live: USD→NGN 1,550 with its time |
| Multi-product orders never counted repeatedly | shipping and tax allocated pro rata by line value (`economics-evidence.db.test.mjs`); a multi-product campaign's sales are evidence for no single product |
| Test, daily and loss limits distinct | separate inputs and ceilings, with property tests (`recommend.test.ts`) |
| Every recommendation reproducible | recomputed from stored inputs (`portfolio.test.ts`); live: 27 of 27 |

### 5. Before and after, re-run

The six scenarios under version 2 keep every verdict and budget (`comparison.test.ts`):
- the maximum viable CPA moves from $26.11 to $26.07 (exact bounds are more conservative);
- scenario E's falls from $30 to $25.80 (the estimate downside);
- every product says the purchase basis is unconfirmed.

The change from the old engine stands as reported: $12,012 over 14 days against $1,092. Version 2 matters where the scenarios had nothing to show:
- cash on delivery: $24 → $20.25 or $25.31;
- zero costs;
- estimates;
- small tests.

**Live on staging (omni-beta, version 2):**
- 27 of 27 recommendations reproduce; the hand check is within ₦0.02.
- 1 GO, 25 PILOT, 1 DO NOT LAUNCH, unchanged.
- ₦20,000,000 allocated exactly (18 full, 1 partial).
- 3 stock-limited products that got ₦0 under version 1 now qualify for labelled micro-pilots, unfunded because full tests took the limit.
- 0 failed deliveries on either store, so cash-on-delivery behaviour is covered by synthetic database and unit tests only.

### Found and fixed during finalisation

1. **Wilson bounds under-covered** (above). Replaced by exact bounds in version 2.
2. **A micro-pilot displaced a full pilot** on staging. Micro-pilots are now funded last.
3. **A plan figure was wrong:** "±45%" for 20 sales (P3) is −26% to +38%.
4. **New products had to be checked:** saving an input now requires the product to exist in the shop.
5. **The rollback could not run after use:** it deleted policy version 2, which recorded runs reference. It now retires it (above).

### Rollback

- `0056_economics_finalisation.down.sql`:
  - restores the 0052–0055 functions;
  - removes the new columns, the two new keys and their values, and variant-scoped values;
  - re-activates policy version 1.
- **Version 2 is kept, retired.** Recommendations recorded under it reference it, and still recompute from their stored arguments.
  - *Found in finalisation:* the first draft deleted it, which fails once any version-2 run exists.
- **Re-applying 0056** re-activates the identical row, and refuses a version 2 with other settings.
- **Tested locally:**
  - built from the 0017 baseline;
  - a version-2 run recorded;
  - down, then up again;
  - the full database suite passing afterwards.
