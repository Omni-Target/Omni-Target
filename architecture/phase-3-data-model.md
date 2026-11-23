# Phase 3: Shopify data model corrections

Authorised 2026-11-23, after Phase 2 was accepted. Phase 3 makes the stored Shopify data complete, accurate and reliable enough for Phase 4's product economics and advertising intelligence. It builds on Phase 1 (`phase-1-data-model.md`) and Phase 2 (`phase-2-ingestion.md`); none of that work is redone.

## Constraints carried forward

Every decision approved for Phases 1 and 2 still binds:
- one Shopify shop per workspace and one workspace per shop;
- shop-level encrypted Shopify credentials;
- PostgreSQL for structured commerce data, R2 for files;
- 24 months of detailed orders, with older history kept as monthly summaries;
- Level 1 customer data only;
- redacted data is never restored;
- Trigger.dev for background work;
- bounded, idempotent, checkpointed database operations.

Development stays on `staging`. Nothing is pruned or removed without separate approval and a verified backup.

Phase 3 also works within the **20 scopes the app already holds**. Adding a scope means changing the live Shopify app configuration (`shopify.app.toml`, which also serves production), so any scope Phase 3 finds useful is listed for approval, not added.

## Review of the starting point

**What the mirror already holds** (migrations 0024–0043):
- **Products:** title, handle, status, type, vendor, category name, tags, a 600-character description excerpt, gift-card flag, publication date and first/last sold dates.
- **Variants:** SKU, options, price, compare-at price, taxable, inventory item, tracked, inventory policy, quantity, requires shipping, weight, unit cost with currency, and country of origin. A `fulfillment_service` column exists but is never filled.
- **Product metafields:** value excerpts up to 1,000 characters. Variant metafields aren't imported.
- **Empty tables** created in 0024 and never filled: `metaobjects`, `metaobject_definitions` and `shop_settings` (currency, timezone, country, locales, plan, markets, delivery summary and policies).
- **Inventory levels:** `available` and `on_hand` only.
- **Locations:** active flag, online fulfilment flag, fulfilment-service flag and country.
- **Returns:** status, quantities and a reason handle per line.
- **Refunds:** totals and dates. Refund line items are read only for history arrivals (0042).

**What the worker still reads live from Shopify** (`modules/insights/live.ts` and `fetchShopifyPrespendIntelligence`) each time it builds a shop's insights:
- shop details;
- product images;
- the pre-spend data: ShopifyQL analytics, markets, delivery profiles, locations, discounts, marketing events and activities, policies and locales, product evidence (replaced by the mirror in task 11) and return evidence (up to 25 pages of orders).

**What the Admin API exposes** (2026-07, introspected on omni-beta by `schema-probe.live.test.ts`):

| Area | Fields Phase 3 can read with the current scopes |
|---|---|
| Variants | `barcode`, `unitPriceMeasurement`, `showUnitPrice`, `availableForSale`, `sellableOnlineQuantity`, `requiresComponents`, `productVariantComponents`, `sellingPlanGroupsCount`, variant `metafields` |
| Inventory items | `harmonizedSystemCode`, `countryHarmonizedSystemCodes`, `provinceCodeOfOrigin`, `duplicateSkuCount`, `locationsCount` |
| Inventory levels | `quantities(names: [available, committed, incoming, on_hand, reserved, damaged, safety_stock, quality_control])`, `isActive` |
| Products | `category { id fullName }`, `hasOnlyDefaultVariant`, `options`, `requiresSellingPlan`, `combinedListingRole`, `bundleComponents`, `featuredMedia`, `mediaCount`, `onlineStoreUrl`, `tracksInventory`, `totalInventory` |
| Locations | `fulfillmentService { handle serviceName type inventoryManagement }` (types: `MANUAL`, `THIRD_PARTY`, `GIFT_CARD`), `shipsInventory`, `hasActiveInventory`, `deactivatedAt` |
| Orders | `productNetwork` (contains Shopify Collective products), `returnStatus`, `customerJourneySummary` (first and last visit: landing page, referrer, UTM parameters, source type; days to conversion; customer order index) |
| Line items | `restockable`, `nonFulfillableQuantity`, `requiresShipping`, `isGiftCard`, `vendor` |
| Returns | `decline { reason }` (`RETURN_PERIOD_ENDED`, `FINAL_SALE`, `OTHER`), `requestApprovedAt`, return line `processedQuantity`, `refundedQuantity`, `unprocessedQuantity`, `restockingFee`, reason definitions |
| Refunds | `return { id }`, refund line `restockType` (`RETURN`, `CANCEL`, `NO_RESTOCK`, `LEGACY_RESTOCK`) |
| Metaobjects | `type`, `handle`, `displayName`, `fields { key type value }`, definitions with field definitions |

**What the current scopes can't see:**
- Fulfillment orders need the `read_*_fulfillment_orders` scopes, which aren't held. Order-level fulfilment routing is therefore unavailable and recorded as such.
- Shopify exposes no product-level "final sale" setting in the Admin API. Non-returnability shows up only as return declines with reason `FINAL_SALE`, plus merchant-entered tags, metafields and policy text. These are recorded as *unverified* signals.
- Shopify Collective: orders carry `productNetwork`, and Shopify tags Collective products and orders "Shopify Collective". The product tag is the only product-level signal.

## Tasks

| # | Task | Workstream | Migration | Depends on |
|---|---|---|---|---|
| 1 | Plan, investigations and housekeeping: order reconciliation, webhook destinations, worker availability, legacy snapshot audit and cleanup proposal | issues 1, 4, 5, 6 | none | — |
| 2 | Product and variant completeness: specifications, variant metafields, metaobjects and definitions, compatibility references, media metadata, description bounds | A, E (images) | 0044 | 1 |
| 3 | Inventory and fulfilment: all inventory states by location, fulfilment services, Shopify Collective, shop-wide availability that never assumes one location is the shop | B | 0045 | 2 |
| 4 | Returns and restrictions: return and refund detail, refund↔return links, return eligibility signals, return evidence computed from the mirror | C, E (return evidence) | 0046 | 2 |
| 5 | Shop context in the database: settings, markets, shipping, policies, locales, analytics, discounts and marketing history, synced in the background; the insights worker stops reading Shopify | E | 0047 | 2, 4 |
| 6 | Product data-quality flags: per-field states (present, empty, missing, unavailable, unverified) with reasons, stored and exposed to the read path | D | 0048 | 2–5 |
| 7 | Historical adjustments: cancellations, order edits, returns and customer counts in finalised and history months | issue 2 | 0049 | 4 |
| 8 | Acquisition attribution: non-sensitive order attribution (channel, UTM, referrer host, landing path), restoring the per-product channel mix the GraphQL mirror lost | issue 3 | 0050 | 1 |
| 9 | Verification and completion report: real-data comparisons, synthetic fixtures for what the test stores lack, incremental and reconcile paths, redaction, and a check that no page needs Shopify | all | none | 2–8 |

Migration numbers are provisional. Each task ships its own migration with a `.down.sql`, a database test and unit tests, as in Phase 2.

### Task details and acceptance criteria

**Task 2: product and variant completeness**
- Bulk and by-ID catalog queries gain:
  - the variant and inventory-item fields above;
  - variant metafields, still within 5 connections and 2 levels of nesting;
  - product media metadata: featured image URL, alt text, dimensions and media count;
  - the taxonomy category ID;
  - bundle, combined-listing and selling-plan flags;
  - a truncation flag for the description (the excerpt stays at 600 characters, the storage review's decision).
- Metafields gain `owner_type = 'variant'`, and reference metafields keep their referenced GIDs.
- Metaobjects referenced by product or variant metafields, and their definitions, are imported:
  - by ID in batches after the catalog import;
  - through the incremental sync on product updates;
  - fields bounded to 8 KB.
- Specifications (dimensions, materials, compatibility and so on) are read from the definitions Shopify reports, both the standard `shopify.*` category attributes and merchant definitions. Values are never inferred from titles or tags.
- **Acceptance:**
  - stored values for every new field match Shopify for the dev store and for a sample of omni-beta products re-synced by ID;
  - absent values stay null, never defaulted;
  - capacity growth is measured per product and recorded in `capacity-measurements.md`.

**Task 3: inventory and fulfilment**
- Inventory levels store all eight quantity states. "Unavailable" is defined as damaged + quality control + reserved + safety stock, as Shopify defines it.
- Locations store fulfilment-service details.
- Orders store `product_network`.
- A product counts as Collective when it carries Shopify's Collective tag, and the evidence source is recorded.
- A read function gives per-variant availability by location and a shop-wide total over locations that are active and fulfil online orders. Each figure states which locations it covers.
- Fulfillment-order routing is marked unavailable for lack of scope.
- **Acceptance:**
  - quantities match Shopify per item and location;
  - a shop with several locations never reports one location as the shop total;
  - third-party and Collective cases are covered by synthetic fixtures if the test stores lack them.

**Task 4: returns and restrictions**
- Returns store:
  - the decline reason;
  - the approval time;
  - processed, refunded and unprocessed quantities per line;
  - restocking fees;
  - reason definitions;
  - the RMA name (Shopify's return `name`, already stored).
- Refunds store their return link. Refund line items (product, variant, quantity, restock type) are fetched by ID for refunds that have lines, so refunded units are no longer inferred from `quantity - currentQuantity`, which also counts order edits.
- Line items store `restockable`, `non_fulfillable_quantity`, `requires_shipping` and `is_gift_card`.
- Return eligibility per product is a set of signals, each tagged with its source and verification state:
  - gift card;
  - declined as final sale;
  - merchant tag or metafield;
  - refund-policy text.
- Return evidence (rates, reasons, maturity) is computed in SQL from the mirror, replacing the live 25-page fetch.
- **Acceptance:**
  - refund and return associations match Shopify;
  - the mirror's return evidence equals the live computation on the same orders;
  - non-returnable and RMA scenarios are tested with fixtures where the stores lack them.

**Task 5: shop context in the database**
- A `shop-context-sync` Trigger.dev task (per shop, one at a time) runs daily, after install, and on `shop/update`, `locations/*` and market or delivery changes. It fills `shop_settings`:
  - shop details;
  - markets with their status and countries;
  - delivery zones;
  - policies, bounded;
  - locales.
- It also fills a bounded `shop_context` record: the ShopifyQL analytics snapshot, active discounts and recent marketing history.
- `shop-insights` reads only the database. Product images come from task 2's columns.
- **Acceptance:**
  - stored context matches Shopify;
  - a test proves `computeShopInsights` makes no Shopify request;
  - a boundary test keeps Shopify clients out of `src/app` pages;
  - stale context is reported with its age, never silently.

**Task 6: product data-quality flags**
- Per product and variant field that Phase 4 uses (unit cost, price, compare-at price, weight, inventory, fulfilment, return eligibility, specifications, description, images, category), a state is recorded:
  - `present`;
  - `empty`: Shopify confirms there is no value, and none is expected (for example no compare-at price);
  - `missing`: readable but not set by the merchant (for example no unit cost);
  - `unavailable`: we could not read it (scope, withheld field, domain not imported, truncated);
  - `unverified`: present but from a merchant free-text signal, or stale.
- Each state carries a reason code. Flags are computed in bounded SQL batches after imports and syncs, versioned with `calc_version`, and exposed with product evidence. Nothing is filled in.
- **Acceptance:**
  - golden cases for each state;
  - a property test that a flag never claims `present` for a null value;
  - flags match a hand-checked sample on the dev store and omni-beta.

**Task 7: historical adjustments**
- Each case gets a reliable rule:
  - cancellations of already-counted orders in finalised and history months;
  - order edits (line changes after finalisation);
  - returns: their refunds already adjust revenue, while returned units become their own adjustment;
  - customer counts.
- Each rule is either implemented as an adjustment or explicitly marked "as finalised", with the effect on Phase 4 documented.
- **Acceptance:** effective summaries equal Shopify's figures on real data after a cancellation and an edit to old orders, or on synthetic fixtures where real changes cannot be made.

**Task 8: acquisition attribution**
- Assessment first: the per-product acquisition channel mix (`acquisition_channels`) is shown today, but since task 11 its input is empty, because the GraphQL mirror has no referring or landing site.
- Proposed fields per order:
  - derived channel;
  - UTM source, medium and campaign;
  - referrer host (no path or query);
  - landing path (no query string);
  - days to conversion;
  - customer order index.
- No IP addresses, user agents, full URLs or customer identifiers.
- **Acceptance:**
  - channel mix from the mirror equals the REST-based computation on the same orders;
  - redaction removes nothing new, because nothing stored identifies a person;
  - the assessment is recorded.

**Task 9: verification and completion report**
- Live comparisons on omni-beta and the dev store for every new field.
- Synthetic fixtures for anything the stores lack, labelled as synthetic.
- Incremental and reconcile paths for each new field.
- Redaction and history checks.
- The Phase 3 completion report.

## Capacity

The staging database is on the Free plan with a 393 MB import guard. omni-beta's catalog mirror holds 100,025 of its 500,025 products, because a full catalog re-import is refused by the guard (correctly). Catalog verification therefore uses:
- the dev store in full;
- omni-beta products re-synced by ID through the incremental path.

Each task measures its growth per product and per order.

## Task results

### Task 1: investigations and housekeeping (2026-11-23; no migration)

**Order reconciliation** (`order-reconciliation.ts`, live check `order-reconciliation.live.test.ts`). The check reads every order Shopify reports for a shop (ID, processed date, status, test and cancelled flags). It compares orders inside the retained window one by one with the mirror's detailed rows, and every month with the effective monthly summary (summary plus adjustments, counting orders that are neither test nor cancelled).

On omni-beta, all 2,220 orders are accounted for and nothing failed to import:

| | Orders |
|---|---|
| Shopify, total | 2,220 |
| Processed inside the window (since 2024-11-01), held as detailed rows | 1,665 (mirror: 1,665, every ID matched) |
| Processed before the window, held only in monthly summaries | 555 |
| Test / cancelled | 0 / 0 |
| Effective monthly summaries over all 31 months | 2,220 (2,034 summarised + 186 by adjustment); every month equals Shopify's count |

The 220-order difference is the simulation added on 2026-11-22, after the 1,500 + 500 figures in the Phase 2 report were measured. It added 220 new orders, each refunded:
- 165 were processed inside the window, so they are detailed rows. Those in months already finalised also became `correction` adjustments.
- 55 were processed before the window and became history arrivals (0042).

That makes 1,500 + 165 = 1,665 detailed orders and 500 + 55 = 555 history orders.

In-window orders by Shopify's financial status, identical in the mirror order by order:

| Status | Orders | Notes |
|---|---|---|
| paid | 1,499 | One (#2998) has a zero-amount refund, so Shopify keeps it `paid` |
| refunded | 107 | Refund equals the order total |
| partially_refunded | 58 | |
| none | 1 | #1001, created through an app (its source is an app ID): Shopify reports no financial status, and the mirror stores null, not a guess |

Exclusions that apply downstream, not in storage:
- The insights read path uses paid and partially refunded orders (1,557). Fully refunded orders (107) and orders with no status (1) are left out of sales figures by design.
- Summaries count every status except test and cancelled orders.

**Webhook destinations** (`webhook-destinations.live.test.ts`). The intended staging host is **`staging.app.omnitarget.co`**; `app.staging.omnitarget.co` appeared only in an earlier runbook line, now corrected (`scripts/ops/runbooks/deployments.md`). The audit found:
- **omni-beta:** 20 sync subscriptions, all at `https://staging.app.omnitarget.co/api/shopify/webhook`. It had no `app/uninstalled` or `shop/update` subscription.
- **Dev store:** no sync subscriptions, and one `orders/paid` subscription at **production** (`https://app.omnitarget.co/api/shopify/webhook`), created by an earlier install.
- **Cause:** installs register `app/uninstalled`, `shop/update` and `orders/paid` through REST at `NEXT_PUBLIC_APP_URL`. That is `http://localhost:3000` in local development, which Shopify refuses, and it ignored `SHOPIFY_WEBHOOK_BASE_URL`, which the sync subscriptions use.

Fixes:
- One endpoint rule for every subscription: `syncWebhookEndpoint()` (`SHOPIFY_WEBHOOK_BASE_URL`, else the app URL, HTTPS only) is used by the install-time registrations too, which are skipped when there is no public endpoint.
- `app/uninstalled` and `shop/update` are now part of the managed subscription set, with their full payload. The access check and the daily reconcile repair them like the sync topics.
- `.env.local` sets `SHOPIFY_WEBHOOK_BASE_URL=https://staging.app.omnitarget.co`, so the local worker maintains staging subscriptions. Production leaves it unset, as before.
- Both staging shops now hold 22 subscriptions at the staging endpoint. The endpoint answers and refuses an unsigned delivery (401).
- **Left for a decision:** the dev store's `orders/paid` subscription to production was not removed. It delivers to production and may belong to a production installation we cannot inspect, so removing it counts as a production webhook change.

Compliance webhooks are app-level (`shopify.app.toml`) and always go to production. They are unchanged.

**Worker availability.** Staging's background jobs run in the Trigger.dev development worker on this machine (`pnpm dev:trigger`), against the staging database:
- When the machine is off, webhooks still reach the staging deployment and wait in the inbox. Scheduled runs are missed, not replayed, and the next runs after a restart pick up what accumulated, because every job is idempotent over its window.
- An unattended hosted deployment (Trigger.dev Production, deployed with `trigger deploy --prod`, its variables and schedules) is a production release requirement. It is already listed on `release-checklist.md` and is not a reason to change anything now.
- Documented in `deployments.md`.

**Legacy per-user snapshots: audit.** `user_integrations.store_snapshot` (jsonb) and `store_snapshot_at` have no reader since task 11. Remaining consumers:

| Consumer | Kind | Uses |
|---|---|---|
| `src/lib/db.ts` `markStoreSnapshotStale`, called from `src/app/api/shopify/webhook/route.ts` (orders/paid) | request handler | Clears `store_snapshot_at`; nothing reads it any more |
| `src/lib/db.ts` `listStoresDueForSync` | dead code | Reads `store_snapshot_at`; no callers since the sync cron became dispatch-only |
| `src/lib/db.ts` `clearShopCredentials(clearSnapshot)` | redaction fallback (when the 0016 RPC is missing) | Nulls `store_snapshot`; tested in `shop-redaction.test.ts` |
| `public.redact_shop_data` (0016, 0018) | database function | Nulls both columns if they exist (column list read from `information_schema`, so a drop does not break it) |
| `src/lib/types/integration.ts` | type | Declares both fields |
| `scripts/ops/db-inspect.mjs` | read-only ops script | Reports the blob size when the column exists |
| `scripts/verify-shopify-return-query.mjs` | old developer script | Picks a shop by the snapshot's store name |
| `campaigns/generate`, `generate-brief`, `store/insights` routes; `onboarding/audit` comment | naming only | A local variable called `store_snapshot` holds `shop_insights` data; the column is not read |
| Trigger.dev tasks, crons | none | — |

Staging holds 3 `user_integrations` rows, 2 with a snapshot (183 KB in total, newest 2026-11-19). Production was not inspected.

**Legacy per-user snapshots: cleanup proposal** (reversible, one PR per step, **not started; needs approval**):
1. **Stop touching the columns:**
   - remove `markStoreSnapshotStale` and its webhook call, and `listStoresDueForSync`;
   - stop `clearShopCredentials` naming the column;
   - rename the routes' local variables, and update the type and the two scripts.
   - Code only; revert by reverting the PR.
2. **Archive.** After a fresh verified backup, export `clerk_user_id, store_snapshot, store_snapshot_at` to an encrypted R2 object with the brief-archive tooling (X25519 + AES-GCM). Prove a byte-identical restore, as task 9 did for briefs.
3. **Clear.** Set both columns to null. Reverted by restoring the archive.
4. **Contract migration.** Drop both columns. The `.down.sql` re-adds them with their types, and the archive restores their content.
5. **Production.** At the release, the same steps after production's own verified backup, under separate approval.

Steps 2–4 change stored data and wait for explicit approval.

**Schema probe** (`schema-probe.live.test.ts`): introspection only, used for the field review above. It is run with `LIVE_TYPES` and `LIVE_OUT`.

### Task 2: product and variant completeness (2026-11-23; migration 0044)

**What is read.** The bulk catalog query and the by-ID product queries now add:
- **Products:**
  - the taxonomy category ID;
  - option names;
  - default-variant, selling-plan, bundle and combined-listing flags;
  - featured image URL, alt text and size;
  - media count;
  - Online Store URL;
  - a description-truncation flag.
- **Variants:** barcode, available for sale, bundle components, unit-price measurement, harmonized system code and province of origin.
- **Variant metafields.**

The bulk query stays within Shopify's limits (4 connections, nested 2 deep). In the by-ID path, variants come 25 at a time with their first 10 metafields; a variant with more has them paged.

**Field-set marker.** `products.fields_version` records which field set a row was last read with. It is null for rows read before 0044, so a missing value there means "not read yet", never "empty", which task 6's data-quality flags rely on.

**What is still not filled in:**
- An unset unit-price measurement (Shopify answers with zeros and no type) is stored as null.
- An image's empty alt text is kept as empty, because Shopify confirms there is none.
- Specifications are only what the shop's metafields and metaobjects hold; nothing is inferred from titles or tags.

**Specifications and compatibility:**
- **Definitions.** Metafield definitions for products and variants (name, type, description) go in the new `metafield_definitions` table. Metaobject definitions, with their display-name field, go in `metaobject_definitions`. Shopify lists both in full, and they are replaced as a whole.
- **Referenced metaobjects.** Metaobjects referenced by product or variant metafields are found from the reference metafields' values, by `catalog_reference_ids` with a partial index, and read 100 at a time by ID. They are stored with field values capped at 500 characters and 6 KB. Newer wins, and a metaobject Shopify no longer has is deleted.
- **When it runs:**
  - after the catalog import;
  - after product webhooks, for missing references only;
  - in the daily reconcile, for definitions and references read more than 20 hours ago.
- A failure here never fails the products themselves: it is recorded, and the next daily run repairs it.
- A metaobject's display name comes from its definition's display field, because the Level 1 guard refuses the `displayName` token in any query.

**Read path:**
- `insight_products` returns the image, field set and variant metafields with definition names; `insight_metaobjects` resolves references.
- Catalog claims now include each referenced metaobject's fields (single and list references; Shopify IDs are not claims), and each distinct variant metafield value, as `variant_metafield`.
- Product images come from the mirror. Only products not yet read with Phase 3's fields still have their image read from Shopify by the worker. Task 5 removes the remaining live reads.

**Results:**

| Check | Result |
|---|---|
| Dev store, catalog-scoped import (bulk path) | 19 products, 32 variants, 13 metafields, 3 referenced metaobjects (`shopify--size`); stored values identical to Shopify's raw answer for every field checked (`catalog-fields.live.test.ts`) |
| omni-beta, 100 products re-read through the by-ID sync path | 100 products, 109 variants, 11 metafields identical to Shopify; 60 s |
| Definitions after the daily refresh | omni-beta 2 metafield definitions + 1 metaobject definition; dev store 3 + 2; identical to Shopify |
| Read path (task 11 equivalence check, dev store) | Orders, products and figures identical to the REST computation; 16 of 17 products with images, now from the mirror |
| Migration round trip | Down restores staging's 0043 schema exactly (76 tables, 184 functions, 171 indexes) |

**Tests:**
- Database (`catalog-completeness.db.test.mjs`, 6 tests):
  - new fields and the field-set marker;
  - variant metafields replaced with their product, removed with their variant, untouched by an older copy;
  - definitions replaced in full;
  - references found from reference types only, missing or stale;
  - newer-wins metaobjects and deletion;
  - the read path's products and metaobjects;
  - ingestibility and grants.
- `commerce.db.test.mjs` registers the new table for deletion.
- Unit tests: mappers (new fields, nulls for absent values, variant metafields, references, definitions, metaobject bounds), by-ID variant metafield paging and reference resolution in the sync, catalog-references (batches, deletions, no rereads, bounds, Level 1), and canonical claims and images.

**Capacity:** see `capacity-measurements.md`, "Phase 3 additions". It is about +4% for the incident-scale shop.

**Limits:**
- omni-beta's other 99,900 mirrored products keep their Phase 2 fields until Shopify changes them or a catalog import runs; a full re-import is refused on staging's Free plan.
- Metaobjects that reference other metaobjects are resolved one level deep.
- Metaobjects no longer referenced stay stored until the shop's data is deleted (small).

### Fix: planner statistics after an import (2026-11-23; migration 0045)

**Found by** Task 2's run of the Phase 2 scale harness (the small scenario, on a database already holding 1M orders from earlier runs). A Phase 2 defect, independent of Task 2.

**What happened.**
- An import summarises a new shop's months straight after its bulk writes, before autovacuum has analysed the tables.
- The planner's statistics listed every existing shop among `shop_key`'s most common values, so it estimated a shop it had never seen at one row.
- The sale-date update in `summarise_detail_month` then chose nested loops that filter joins row by row.
- One month of a 1,500-order shop took 2 min 7 s and failed against the 8 s statement timeout.
- After `ANALYZE`, the same call took 0.07 s.
- This is most likely on a database with few shops, which is staging and early production. omni-beta's real import was not affected, because its statistics were current.

**Fix.**
- `refresh_mirror_statistics(table)` analyses one table from a fixed list of mirror and history-staging tables. It is service role only.
- The import calls it for the staged history before summarising history months, and for the mirror tables before deriving customer facts and summarising the window.
- It is never fatal; timings are recorded in the import's coverage.

**Verified:**
- Without the fix, the small scenario failed on every new shop (3 runs).
- With it, the scenario passes: catalog, inventory, orders, 200 history orders over 24 months and returns, with the customers domain denied by design.
- Database test `import-statistics.db.test.mjs`: each listed table is analysed; other tables and inputs are refused, as are other roles.
