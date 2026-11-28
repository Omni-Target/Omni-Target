# Phase 5: product readiness, channel fit, geography and Meta interests

Authorised 2026-11-25, to begin once Phase 4 closed (closed 2026-11-25; policy version 3 active). Phase 5 decides, for a product the economics engine allows to be advertised, **whether it is ready**, **where it can be sold and advertised**, **which channels the evidence supports**, and **which Meta interests are real and relevant**. Every answer is explainable, and verified evidence is kept apart from assumptions.

## Constraints carried forward

- All work on `staging`; every PR targets `staging`; nothing on `main`, production data, credentials, configuration or deployments. New production requirements go on the release checklist.
- **The Phase 4 economics engine is the financial authority.** Phase 5 never overrides `DO_NOT_LAUNCH`, `BLOCKED` or `INSUFFICIENT_DATA`, never produces a budget, and can only add restrictions (never remove one).
- No Meta campaign publishing, no advertising spend, no direct campaign creation.
- Deterministic, versioned rules. The AI writes copy from an evidence package; it never decides a location, an interest, a channel or a figure.
- Task-by-task PRs with Verify and Database CI.
- Decisions already made are not reopened.

## Task 1: audit of what exists (2026-11-28)

| Area | Where | What it does today | Problem |
|---|---|---|---|
| Market serviceability | `src/lib/shopify-readiness.ts:22` (`assessShopifyMarketReadiness`) | Store-level check: an active market and a shipping zone with active methods contain the country; a fulfilling location with stock | Never reaches the economics engine: `targetMarketServiced` (`src/modules/economics/recommend.ts:135`) is always `null`, so `TARGET_MARKET_NOT_SERVICED` never fires. Not per product (a product that does not ship, or is not in the market's catalogue, is not distinguished) |
| Locations in briefs | `src/lib/insights-engine.ts:181-189, 374-445, 572-584, 690` | The AI writes the locations. It is fed one **store-wide** top-locations list. For non-Tier-1 stores the prompt asks it to add "2–4 strategic international expansion cities … diaspora affinity" | Locations are inferred, not evidenced (GEO-03). International cities are recommended without measured cross-border demand, an active market or a shipping zone. The list is the same for every product |
| Tier-1 and diaspora | `src/lib/market-geography.ts:94, 648` | Tier-1 decided by currency; diaspora by a city list | Currency is not a market; heuristics presented as facts |
| Meta interests | `src/lib/meta-interest-resolver.ts:93-245, 353-434` | Seeds always start with "Online shopping"; category rules are fashion-specific regexes; live search via Graph **v19.0**; returns names only | IDs discarded; when the search fails or finds fewer than 3, **unverified seeds are returned in the same list as verified ones** (GEO-04); "premium" assumed when price data is missing (`:285`); a product outside fashion gets generic seeds |
| Meta API version | 7 call sites: `meta-interest-resolver.ts:307, 334`, `auth/meta/connect:25`, `auth/meta/callback:58, 81, 88`, `shopify/webhook:102` (Conversions API), `user/delete-account:20`, `dashboard/stats:49` | Hard-coded `v19.0` | Graph API v19.0 expired 2026-05-21 and Marketing API v19.0 on 2025-02-04 (Meta's changelog, read 2026-11-28). Calls are answered only because Meta auto-upgrades them. Marketing API **v25.0** is the only unexpired Marketing version; Graph v25.0 runs to 2028-07-29 |
| Meta targeting model | — | Interests treated as hard targeting | Marketing API v24.0 (October 2025) consolidated detailed-targeting interests; deprecated ones stopped delivering on 2026-01-15. For conversion objectives Meta applies Advantage+ audience, so interests act as **suggestions**, not limits. Interests must be re-verified when used, and presented as signals |
| Channel evidence | `orders` attribution columns (0051), `parseTrafficSource` | A per-product channel mix exists in the snapshot | No channel-fit judgement; Meta is the implicit default |
| Product readiness | `src/modules/quality/rules.ts` (Phase 3 flags), `src/lib/ad-readiness-score.ts` (store score), `src/lib/gateway-decision.ts` (selection) | Quality flags per field; a store-level readiness score | No per-product readiness verdict combining publication, content, fulfilment, returns, tracking and the economics verdict |

## Design

New module `src/modules/intelligence/` (pure rules, versioned) with repository functions over the canonical tables. Each result names its evidence and labels every statement:

- **verified**: observed in the shop's own Shopify data, or confirmed by Meta's API at a recorded time;
- **inferred**: produced by a stated, versioned rule (for example, a product type's typical channel), shown as an assumption;
- **unknown**: the evidence could not be read; never treated as negative.

### Order of authority

1. **Economics verdict (Phase 4).** `DO_NOT_LAUNCH`, `BLOCKED`, `INSUFFICIENT_DATA` stand. Nothing below changes them or their budget.
2. **Market serviceability** feeds the economics engine as `targetMarketServiced`: not serviced → `BLOCKED` (`TARGET_MARKET_NOT_SERVICED`); unknown → no restriction, stated.
3. **Readiness** can add blocking findings ("not ready to advertise") that hold any amount back until fixed; it never upgrades a verdict.
4. **Channel fit, geography and interests** are guidance attached to GO and PILOT products only.

### Market serviceability (feeds the engine)

For a product and a target country:

- **Serviced** when an **active** Shopify market contains the country, a delivery zone with active methods covers it (for products that require shipping), and a location that fulfils online orders holds stock.
- **Not serviced** when the market and shipping data were read and any of these is false.
- **Unknown** when the data could not be read (scopes, never synced). Unknown never blocks.
- **The target country** is the merchant's chosen target, defaulting to the shop's country. A cross-border target is recommended only with measured cross-border demand (orders shipped there), plus an active market and shipping (Phase 0 plan), and is kept apart from the domestic plan.

### Product geography

- **Where the product's buyers are,** from its own paid orders' shipping country, region and normalised city (S1's country-aware normalisation; raw values kept).
- **Hierarchy with labelled scope:** the product's own orders first, then its category or product type, then the store. Each level is used only above a minimum sample, and every location carries "measured from N orders, scope: product | category | store".
- **No invented locations.** The AI no longer writes locations; it may only phrase the ones the evidence gives. International expansion appears only as a separate, evidenced section.

### Channel fit

- **Evidence:** the product's paid orders by acquisition channel (Phase 3 attribution: visit source, UTM, referrer), first versus returning buyers (`customer_order_index`), days to conversion, and any tracked campaign results (Phase 4).
- **Output per channel** (Meta, Google search and shopping, TikTok, email and retention, organic): `supported` (measured share above a threshold with enough orders), `plausible` (a stated product-trait rule, labelled inferred), `unsupported`, or `unknown` (no attribution recorded). Each comes with its evidence.
- **Meta is not the default:** a product whose sales come from search is told so. Orders created through the API (no journey) are counted as unknown, never as direct.

### Readiness

Per product, each check is `pass`, `attention`, `fail` or `unknown`, with evidence and the fix:

| Check | From |
|---|---|
| Active, published to the online store, with a product page | products (status, `online_store_url`, `published_at`) |
| Images, description, category | Phase 3 quality flags |
| Price and compare-at price consistent | quality flags |
| Ships to the target market | market serviceability |
| Stock and fulfilment | economics inventory facts |
| Return eligibility and policy | quality flags; shop policies |
| Purchase tracking | Meta pixel or Conversions API connected; purchase-event basis confirmed (Phase 4) |
| Economics | the Phase 4 verdict and its reasons, quoted, never restated |

Overall: `READY`, `NEEDS_ATTENTION` (advertising allowed, fixes recommended) or `NOT_READY` (a failed blocking check: no product page, not shipped to the target market, no purchase tracking). `NOT_READY` holds back any amount.

### Meta interests

- **Seeds** come from the product's own evidence: Shopify category (taxonomy path), product type, title nouns and specification metafields. The AI may propose candidate terms, marked as hypotheses. "Online shopping" and fashion-only rules are removed.
- **Every recommended interest is verified** through Marketing API v25.0 (`search?type=adinterest`, `adinterestsuggestion`) at research time. Stored with its **ID**, name, path, topic, audience-size bounds, the API version and the time verified.
- **Unverified terms are never presented as interests.** They appear, if at all, as "not found in Meta's targeting options".
- **A result is not reused after 30 days without re-verification,** because Meta consolidates interests.
- **Presented as Advantage+ audience suggestions,** never as a promise that delivery is limited to them.
- **Relevance guards:** audience size, topic and commercial disambiguation (kept from the current resolver), gender only from the product's own evidence, and the price tier only when price data exists (never assumed premium).

### Recording and reproducibility

Each product assessment (serviceability, geography, channels, readiness, interests) is recorded with its rule version, inputs and outputs, alongside the economics run it used, and recomputes from what is stored. Meta's API answers are stored as inputs, so a recomputation never calls Meta.

## Rules and defaults (versioned in code, proposed for CEO review at completion)

| Rule | Default | Why |
|---|---|---|
| Product-level geography | ≥ 20 paid orders with a shipping address | Below that a product's own mix is noise; fall back to category, then store |
| Category-level geography | ≥ 50 paid orders | Same, at the wider scope |
| A location listed | ≥ 5% of the scope's orders and ≥ 3 orders | No single-order cities |
| Cross-border target | ≥ 10 paid orders shipped to the country in 365 days, plus an active market and shipping | Measured demand, not inference |
| Channel `supported` | ≥ 20% of the product's attributed paid orders and ≥ 10 orders | A channel that already sells the product |
| Attribution coverage | Channel fit is `unknown` below 30% of orders with a recorded journey | API-created or legacy orders carry no journey |
| Interest audience | ≥ 200,000 (lower bound) | Kept from the current resolver |
| Interest re-verification | after 30 days | Meta consolidates interests |
| Meta API version | Marketing and Graph **v25.0**, in one constant | The only version valid for both APIs today |

## Tasks

| # | Task | Migration |
|---|---|---|
| 1 | This audit and plan | none |
| 2 | Meta API version: one constant at v25.0 for all seven call sites, with tests; release-checklist note | none |
| 3 | Market serviceability per product and target country, fed to the economics engine as `targetMarketServiced` | 0061 |
| 4 | Product geography evidence with labelled scope; briefs stop using AI-written and store-wide locations | 0062 |
| 5 | Channel fit from attribution and campaign evidence | (in 0062 or 0063) |
| 6 | Product readiness checks and the order of authority | 0063 |
| 7 | Meta interest research: evidence seeds, verified results with IDs, storage, Advantage+ framing | 0064 |
| 8 | Integration: one recorded product assessment; briefs, PDF, plain text and planner render it; AI boundary tests | 0065 |
| 9 | Verification on staging, before-and-after comparison, completion report | none |

## Acceptance criteria

- `TARGET_MARKET_NOT_SERVICED` fires for a product whose target country has no active market or shipping, and never on unknown data.
- No brief location, interest or channel comes from the AI; each carries its evidence and scope; international expansion only with measured demand.
- Every interest shown was verified by Meta's API, with its ID and the time verified; none unverified appears as an interest.
- No Phase 5 output changes a Phase 4 verdict or budget, except adding `TARGET_MARKET_NOT_SERVICED` or a `NOT_READY` hold (property-tested).
- Every assessment recomputes from its recorded inputs.
- Live checks on omni-beta and the dev store.
