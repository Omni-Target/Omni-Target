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

### Task 3: inventory and fulfilment (2026-11-23; migration 0046)

**What is read and stored:**
- **Inventory levels:** every quantity state Shopify reports (available, committed, incoming, on hand, reserved, damaged, safety stock, quality control) and whether the level is active.
- **"Unavailable"** is computed as Shopify defines it: damaged + quality control + reserved + safety stock.
- **Null means not read.** Rows written before 0046 hold available and on hand only, with the other quantities null.
- **Locations** (`includeLegacy` too, see below):
  - fulfilment-service handle, name and type (merchant-managed `manual`, `third_party`, `gift_card`), and whether the service manages inventory;
  - whether the location ships inventory or has active inventory;
  - when it was deactivated;
  - the field set it was read with.
- **When locations are read:**
  - at import;
  - daily (`sync-reconcile`);
  - whenever an inventory webhook names a location, because by-ID inventory reads now return each level's location in full.
- **Levels at locations an item no longer stocks** are removed when a by-ID read gives the item's complete current list (`ingest_inventory`'s `p_complete_items`). A bulk export is never treated as complete, since it may be older than a level a webhook wrote meanwhile.

**Availability (`inventory_availability`):**
- **Per variant:** levels by location; totals over the locations that are active and fulfil online orders (the shop's sellable stock); and totals over all active locations.
- **Unknown locations:** levels at a location the mirror does not know are counted apart, never in a total.
- **State:** `untracked`, `unknown` (tracked, no level stored), `in_stock`, `oversell_allowed` (none available, keeps selling) or `out_of_stock`.
- **Who fulfils it:** merchant, third party or other service.
- **Shopify Collective:** whether it is a Collective product, from Shopify's own tag.
- **The shop total is never one location's stock.** Stock held only at a location that does not fulfil online orders leaves the variant out of stock online (tested).

**Sellable, not merely counted (Phase 0 finding ING-09):**
- `variantSellable` treats untracked variants, and variants whose policy is to keep selling, as sellable whatever their quantity. Variants of unknown tracking keep the quantity rule, so nothing changes without evidence.
- The read path passes each variant's tracking and policy on, and its quantity is now the online locations' stock when levels are stored.
- The snapshot's stock flags and the gateway decisions' stock hold both use the rule.
- **Effect on omni-beta:** 98,667 of its 100,027 products had no variant with a positive count and so read as out of stock. 98,596 of them are sellable, because Shopify does not track their inventory.

**Shopify Collective and third-party fulfilment:**
- **Collective products** carry Shopify's "Shopify Collective" tag, which is reported per variant. The order-level flag (`Order.productNetwork`) arrives with task 4's order changes.
- **Third-party fulfilment, real data.** Both test stores have a legacy third-party fulfilment-service location, "Snow City Warehouse" (`snow-city-warehouse`). It holds stock that the mirror stored but could not place, because `locations` omits legacy fulfilment-service locations unless asked (`includeLegacy: true`). It is now stored with its service details on both stores.
- **Fulfillment orders** (which location fulfils an order) need scopes the app does not hold (`read_*_fulfillment_orders`), so order-level routing stays unavailable. Adding them would change the live app configuration, which needs approval.

**Results:**

| Check | Result |
|---|---|
| Dev store, inventory-scoped import | 32 items, 40 levels: every quantity state, level activity and location identical to Shopify; online totals recomputed from Shopify's own data identical (`inventory.live.test.ts`) |
| Locations after the refresh | Dev store and omni-beta: 3 each, including the third-party warehouse, identical to Shopify |
| omni-beta, 100 inventory events re-read by ID | 98 items, 100 levels identical; online totals identical |
| Read path (equivalence check, dev store) | Unchanged against the REST computation |
| Migration round trip | Up and down on a fresh database |

**Tests:**
- Database (`inventory-fulfilment.db.test.mjs`, 4 tests): quantities and fulfilment services; complete-item replacement, never from a bulk batch, newer wins; availability by location, online-only totals, unknown and inactive locations, every state, Collective; grants. The Phase 2 ingest test follows the new signature.
- Unit tests: `variantSellable`; the gateway decision no longer holds an untracked or keep-selling product (fails on the old rule); the canonical variant mapping; the mappers (every quantity, locations with services, locations from by-ID reads); the sync's complete-item write.

**Limits:**
- omni-beta's other levels keep their Phase 2 quantities until they change.
- Order-level fulfilment routing needs scopes the app does not hold.
- Collective supplier names are only in merchant tags; they are not read as a separate field.

### Task 4: returns and restrictions (2026-11-23; migration 0047)

**What is read and stored:**
- **Orders:** the Shopify Collective flag (`productNetwork`: the order holds products a supplier fulfils) and the order's return status.
- **Order lines:** restockable, non-fulfillable quantity, requires shipping, gift card.
- **Refunds:**
  - the return each refund settles, from both sides: `Refund.return`, and each return's refunds in the returns export;
  - their line items (order line, quantity, restock type: return, cancel, legacy restock or no restock; subtotal) in the new `refund_line_items` table.
  - A bulk export cannot nest a refund's lines, so stored refunds are read by ID, 10 a call, after the orders import, after order webhooks and daily. Each refund is marked read, and one Shopify no longer has is marked read with no lines.
  - Refunded units no longer rest only on quantity less current quantity, which also counts order edits.
- **Returns:**
  - the decline reason (`FINAL_SALE`, `RETURN_PERIOD_ENDED`, `OTHER`) and the approval time;
  - return lines' processed, refunded and unprocessed quantities, the reason's name and any restocking fee;
  - the RMA identifier, Shopify's return name (for example `#1001-R1`), was already stored.
  - Customer and staff free-text notes are never read, since they may hold personal data.

**Return eligibility (`product_return_signals`).** Each signal carries its source and how far it can be trusted:

| Signal | Trust | Source |
|---|---|---|
| Gift card | verified | Shopify's gift-card flag |
| Declined as final sale | observed | A return of the product the shop declined with `FINAL_SALE` |
| Tag | unverified | Merchant tag saying final sale, non-returnable or no returns |
| Metafield | unverified | Merchant metafield saying so |

No signal is not proof that a product is returnable. Shopify has no product-level final-sale field, and the refund-policy text is read in task 5.

**Return evidence from the mirror (`product_return_evidence`):**
- **Rules:** the live computation's rules: rates only from 30 eligible units, a reason only from 3 units, risk `review` from a 15% processed return rate.
- **Window:** a year less 60 days, by processed date. This corrects the live fetch, which used the creation date, wrong for imported orders (task 11's finding).
- **Never guessed:**
  - while any refund in the cohort has unread lines, refunded units are withheld (null);
  - while any return was stored before these fields, processed units and the rate are withheld and the risk is `incomplete`.
- **Read path:**
  - the worker no longer fetches return evidence live (up to 25 pages of orders);
  - evidence is used only when the shop's returns were imported; otherwise it is unavailable, not zero;
  - each product carries its return signals.

**Fixed in passing (task 2 gap):** a product deleted in Shopify left its variants' metafields behind. `delete_synced_records` now removes them.

**Results:**

| Check | Result |
|---|---|
| omni-beta refund lines (daily read, first run) | 166 refunds, 231 lines: lines, quantities, restock types and return links identical to Shopify (`returns.live.test.ts`) |
| omni-beta orders re-read by ID | 60 orders: Collective flag and return status identical; 116 lines' restrictions identical |
| Return evidence, mirror against Shopify | 691 orders in the window, 303 products (57 with refunds): eligible, returned and refunded units, rates, reasons and risks identical to the computation over Shopify's own orders |
| Inferred against actual refunded units, omni-beta | Equal for all 231 refunded lines (no order edits there); all refunded without restocking |
| Migration round trip | Up and down on a fresh database |

**Synthetic coverage** (the test stores have refunds but no returns, declines or non-returnable products). The database test `returns-restrictions.db.test.mjs` (5 tests) covers:
- restrictions;
- refund lines read, replaced, kept on later order writes, deleted with their order, and restock type checked;
- return declines, processed quantities, restocking fees and refund–return links;
- every return signal, and none for an ordinary product;
- evidence: window and maturity, cancelled and test orders excluded, the 30-unit rule, the main reason, review risk, refunded units withheld while lines are unread, and incomplete returns;
- variant metafields deleted with their product;
- grants.

**Other tests:**
- the Phase 2 ingest test follows the new returns signature, and `commerce.db.test.mjs` registers `refund_line_items` for deletion;
- unit tests: the mappers (new order, line and return fields; notes never stored; refund nodes), refund lines (batches of ten, paging, deletions, no rereads, the write bound, heartbeat), the sync (refund lines after order writes, failure kept apart), and canonical evidence and signals.

**Limits:**
- Exchanges and reverse fulfilment orders are not read.
- Return evidence covers the retained window only.
- Returns on the test stores: none. Real returns, declines and final-sale products would let the live check cover them too.

### Task 5: shop context in the database (2026-11-23; migration 0048)

**No Shopify request builds or renders the store snapshot.**
- `computeShopInsights` reads only the database:
  - orders, products, images, costs, references, inventory, return evidence and signals from the mirror;
  - shop details and the pre-spend datasets from the stored shop context.
- It imports no Shopify client. A boundary test keeps it that way, and keeps every page and layout under `src/app` free of Shopify reads. The test would have failed on the previous code: six Shopify calls in the worker, two in the settings page.

**The background sync (`syncShopContext`) reads and stores:**
- **`shop_settings`** (created empty in 0024):
  - name and primary domain;
  - currency and money format;
  - timezone;
  - country and province, from the shop's own address as REST gave it (the worker had used the billing address);
  - plan (display name, Plus, development);
  - weight unit and taxes included;
  - the storefront logo;
  - locales, markets, delivery zones and policies (each policy's text bounded to 2,000 characters, marked when cut).
- **`shop_context`** (new):
  - the ShopifyQL analytics snapshot;
  - active discounts and recent marketing history;
  - all locales;
  - each dataset's status (available, partial, missing scope, error);
  - the warnings the read produced, and when it was read.
- **From the mirror, not this sync:** locations (task 3), granted scopes (Phase 2's access check), product evidence (Phase 2 task 11) and return evidence (task 4).

**When it runs:**
- after each import, before the snapshot is requested;
- daily: the new `shop-context-refresh` schedule (04:20) takes shops whose context is over 20 hours old;
- in `shop-insights`, whenever the context is missing or over a day old.
- A snapshot built from a context over 48 hours old carries a warning with its age. Without any stored context, no snapshot is built (`no_context`), rather than one without shop details.

**Pages:**
- The settings page used to fetch the storefront logo while the merchant waited (finding FE-11), when Clerk had none cached. It now reads the logo the sync stored.
- The explicit "sync logo" action and the install flow still read Shopify, as user-initiated or install-time requests, not page renders.
- Product images for products not yet read with Phase 3's fields are no longer fetched live: they have none until read.

**Results:**

| Check | Dev store | omni-beta |
|---|---|---|
| Context sync (`context.live.test.ts`) | 6 datasets available; 2 markets, 2 delivery zones, 1 policy, 1 discount, analytics; 4.4 s | 6 datasets available; 2 markets, 1 zone, 1 policy, 2 discounts, analytics; 4.3 s |
| Stored against Shopify: name, currency, timezone, country, plan, primary domain, markets, policy types, locales | Identical | Identical |
| Snapshot from the database alone | Saved, 1.6 s; carries the stored currency, markets, policies and discounts | Saved, 10.5 s (1,557 orders, 2,000 products) |
| Read-path equivalence (dev store) | Unchanged against the REST computation | — |
| Storefront logo | None found (development store) | None found |

**Tests:**
- `shop-context.db.test.mjs` (4): saved together and read back with locations and scopes; a missing logo keeps the last one; bounds; not ingestible; due shops; access.
- `commerce.db.test.mjs`: `shop_context` registered for deletion, writable only by its function.
- Unit tests: `context.test.ts` (bounds, mirror datasets excluded, round trip, staleness), the canonical builder, and the boundary tests.

**Release checklist:** the `shop-context-refresh` schedule is added, with a first run before `insights-refresh` at release (seven schedules in all).

### Task 6: product data-quality flags (2026-11-23; migration 0049)

**States.** For each of 13 fields Phase 4 relies on, every product in the snapshot carries a state and the reason for it (`StoreProduct.quality`, `calc_version` 1):

| State | Meaning | Examples (reason) |
|---|---|---|
| `present` | Stored as Shopify gives it | `set`, `levels`, `third_party`, `shopify_collective`, `declined_final_sale` |
| `empty` | Shopify confirms there is none, and none is needed | `not_on_sale` (compare-at), `not_shipped` (weight), `untracked` (inventory), `gift_card`, `none_defined` (specifications) |
| `missing` | Readable, but the merchant has not set it | `not_set` / `partial` (unit cost, barcode, weight), `uncategorised`, `no_featured` (image) |
| `unavailable` | Could not be read | `scope_missing`, `inventory_not_imported`, `returns_not_imported`, `no_level_stored`, `not_read` (row predates Phase 3's fields), `no_product_rule` (Shopify has no product-level return rule) |
| `unverified` | Present, but rests on merchant free text, is incomplete or contradicts itself | `tag` / `metafield` (return signals), `currency_differs` (unit cost), `zero_price`, `not_above_price`, `reference_unresolved`, `no_definitions`, `quantities_partial`, `unknown_location` |

The fields are price, compare-at price, unit cost, weight, inventory, fulfilment, return eligibility, specifications, description, images, category, barcode and customs (HS code and origin).

**How it works:**
- **Facts in the database.** `product_quality_facts` (0049) gathers per product, at most 500 a call, what the rules judge: counts over variants, inventory levels, metafields and references, and which field set the product was read with.
- **Rules in code.** `evaluateProductQuality` (`src/modules/quality/rules.ts`) is pure and versioned. It also takes the return signals and what the shop allows to be known: currency, granted scopes, and which domains were imported.
- **Computed when the snapshot is built, not stored.** Flags are always current, cost no storage (a stored copy would take about 10 MB for an incident-scale catalog), and changing a rule needs no migration.
- **Never filled in.** A property test over 2,000 random products checks that no field is ever `present` without its value, and that a field Phase 3 added, on a product read before it, is `unavailable` and never `missing`.

**Results** (`quality.live.test.ts`). Each snapshot product's flags are hand-checked against states derived from Shopify's raw data for the same products, not from the mirror:

| Shop | Sampled | Result |
|---|---|---|
| Dev store | 17 products, 7 fields each | Identical. A real mix: unit cost missing on all 17; category present 3 / missing 14; description present 4 / empty 13; weight present 4 / missing 12 / empty 1 (gift card); compare-at empty 16 / present 1; images present 16 / empty 1; barcode missing 16 / empty 1 (gift card) |
| omni-beta | 100 products, 5 fields (+ images and barcode for the 16 read with Phase 3's fields) | Identical: unit cost present, category missing, description present, weight missing, not on sale, images present, barcodes missing |

**Tests:**
- `product-quality.db.test.mjs` (2): every fact counted on a product with mixed variants, levels at known, unknown and third-party locations, partial quantities, defined, truncated and unresolved metafields, plus a gift card; grants.
- `rules.test.ts` (6): golden cases for each state and the property test.
- The canonical builder attaches flags with the return signals.

### Task 7: historical adjustments (2026-11-24; migration 0050)

**Rules.** How each kind of late change reaches a month whose summary is final:

| Change after a month closed | Final months inside the window (detail held) | History months (summaries only) |
|---|---|---|
| New order | `correction`, by recomputation (0036) | `correction` (0042) |
| Refund | `refund` or `correction`, by recomputation | `refund` (0042), with units from the refund's lines |
| Cancellation | `correction`, by recomputation | **`cancellation` (0050).** Takes back the order and only the refunds that were counted (made before the month closed, or applied as late refunds), once. Nothing is taken back for an order cancelled before its month closed, or never counted |
| Edit to an order's lines or totals | `correction`, by recomputation | As finalised |
| Return (returned units) | `return`, by recomputation | As finalised; its refund adjusts revenue |
| Distinct customers (store, and per product) | **Adjusted (0050):** the difference is recorded with each adjustment | As finalised |
| New and first-time customers | **Adjusted (0050)** | As finalised |

**What changed in 0050:**
- Adjustments carry customer-count differences.
- The effective summaries add them.
- `apply_history_arrivals` handles cancellations, with a `cancellation` ledger subject.
- Final months inside the window were marked for one maintenance run, so the differences that built up before 0050 are recorded.

**Why history stays partly as finalised.**
- Months before the window hold no detail, so an edit or a return there cannot be recomputed. Shopify also rarely allows editing orders that old.
- Correcting distinct customers in a history month would need, for each month, which customers had ordered. That is a lasting per-customer record, which the approved retention decision rules out ("no permanent identifiable customer facts").

**For Phase 4:**
- **Exact for every month, history included:** orders, units, revenue, discounts, tax, shipping and refunds.
- **Customer-based measures** (customers per month, new customers, repeat behaviour) should use the 24-month window, where they are now exact, or the cohort outcomes (Phase 2), not history months.
- **History months' customer counts and returned units** are figures as finalised and should be labelled so wherever they are shown.

**Results on omni-beta:**

| Check | Result |
|---|---|
| Maintenance after 0050 (`summary-adjustments.live.test.ts`) | 42 months refreshed: 20 store and 227 product `correction` adjustments recording customer-count differences; final rows untouched |
| Window months against Shopify's raw orders | 25 store months and 1,642 product-months identical, **including distinct customers per month and per product-month** (compared from 0050; Phase 2 only reported them) |
| History months (`history.live.test.ts`) | 6 months and 452 product-months identical in orders, units, revenue and refunds; customer counts as finalised (for example 2024-06: 75 against Shopify's 92, from the 55 late orders) |
| Cancellation of an old order on a real store | Not possible here: omni-beta's scopes are read-only. Covered by synthetic tests |

**Tests:**
- `history-arrivals.db.test.mjs` (+3):
  - a counted order cancelled late takes back exactly the order and its counted refunds, not the cancellation's own refund, once;
  - nothing for orders cancelled before close or never counted;
  - a late order then cancelled nets to the summary as written.
- `summary-maintenance.db.test.mjs` now requires effective customer counts to equal a recomputation; it previously asserted they stayed as finalised.
- The live adjustments check compares customers.

### Task 8: acquisition attribution (2026-11-24; migration 0051)

**Assessment: needed.**
- The snapshot's acquisition channel mix (per product, and for the shop) is computed from each order's referring site, landing site and sales channel.
- REST gave the first two. The GraphQL mirror had neither, so since Phase 2's read path every order was classed by sales channel alone ("Direct / Organic" for most). That silently degraded the channel evidence Phase 5's channel fit needs.
- Shopify's GraphQL equivalent is the order's customer journey (`customerJourneySummary`).

**Stored per order, with nothing that identifies a person:**
- **Converting (last) visit:**
  - source and source type;
  - the referrer's **host only**;
  - the landing page's **path only**, never the query string, which can carry tokens or e-mail addresses;
  - UTM source, medium and campaign (100 characters each). Shopify's parsed values are used, else those read from the landing page's query; the query itself is never stored.
- **First visit:** source and source type.
- **The order:** days to conversion and its place in the customer's orders.
- **Readiness:** whether Shopify had finished the journey when the order was read.
- **Never read:** IP address, user agent, full URL, referral code, customer identifier.
- **Null** means not read (orders written before 0051) or unknown to Shopify (orders created through the API have no visits).

**Read path.** The order page returns the host, path and UTM values. They are rebuilt into the referring and landing sites REST gave, so the existing classification (`parseTrafficSource`) classes channels exactly as on REST.

**Results:**

| Check | Result |
|---|---|
| omni-beta, 100 orders re-read by ID (`attribution.live.test.ts`) | Identical to Shopify's raw journey: order index and readiness. No order has a visit (all created through the API), so referrer, landing and UTM are null, as in Shopify |
| Read-path equivalence, dev store | Now compares **each shared order's channel** from REST's raw sites against the stored attribution: identical (2 orders, both draft orders) |
| Real referrer and UTM data | Not on the test stores: covered by unit tests (Instagram UTM, Google referrer, TikTok, no visit) |

**Tests:**
- unit: the mapper (host and path only, query strings, e-mail addresses and referral codes never stored, UTM bounds and fallback, no visit) and the channel rebuild;
- `order-attribution.db.test.mjs` (2): stored, read back by the order page, bounds.

**For Phase 5:**
- Channel fit can use the stored channel, UTM and first or last visit.
- The order index separates new from returning buyers per order, without customer data.

### Task 9: verification and completion report (2026-11-24; no migration)

**Final verification.** Every Phase 3 live check was re-run against `staging` at b4ab62e (migrations through 0051), on omni-beta and the dev store:

| Check | Store | Result |
|---|---|---|
| Order reconciliation (`order-reconciliation.live.test.ts`) | omni-beta | Pass |
| Webhook destinations (`webhook-destinations.live.test.ts`) | both | **1 finding:** the dev store still holds one `ORDERS_PAID` subscription to production, left in place for a decision. Both stores hold 22 subscriptions at staging |
| Catalog completeness (`catalog-fields.live.test.ts`) | both | Pass |
| Inventory by location (`inventory.live.test.ts`) | both | Pass |
| Returns and refund lines (`returns.live.test.ts`) | omni-beta | Pass |
| Acquisition attribution (`attribution.live.test.ts`) | omni-beta | Pass |
| Shop context (`context.live.test.ts`) | both | Pass |
| Data-quality flags (`quality.live.test.ts`) | both | Pass |
| Read-path equivalence (`equivalence.live.test.ts`) | dev store | Pass |
| Historical adjustments (`summary-adjustments.live.test.ts`) | omni-beta | Pass |
| History arrivals (`history.live.test.ts`) | omni-beta | Pass |

- **Scale harness, small scenario** (a full import against a simulated shop) at 0051: passes. The outcome is partial by design, and every domain succeeds.
- **Incremental, reconcile and redaction paths** for every new field are covered by the database suite that CI runs on each pull request:
  - `ingest`, `history-arrivals` and `summary-maintenance`;
  - `commerce`, whose deletion lists include `metafield_definitions`, `refund_line_items` and `shop_context`.
- **Synthetic fixtures** are used only where the test stores have no data, and are labelled as synthetic in each test:
  - real returns;
  - customer visits;
  - old cancellations;
  - fulfilment-service quantity states.

**Open decisions:**
1. Approve Phase 4.
2. Whether to remove the dev store's production `orders/paid` subscription.
3. Steps 2–4 of the legacy-snapshot cleanup.
4. Whether to add the optional fulfilment-order scopes, which change the app configuration.
5. Whether to create extra test data on the dev store (returns, visits).
