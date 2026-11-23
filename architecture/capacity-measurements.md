# Capacity measurements (Phase 1, task 10)

Measured 2026-11-17. These figures replace the estimates in the Phase 0 plan (§8.3).

**What this is.** These are local benchmarks: synthetic data in Postgres 17.11 under Docker.
- **Sizes carry over to Supabase.** It uses the same on-disk format; staging runs Postgres 17.6.
- **Timings do not.** Supabase Free runs on shared compute.

**Reproducing it:**
```bash
DATABASE_URL=postgresql://…@127.0.0.1:…/postgres node scripts/ops/capacity-fixtures.mjs --out report.json
```
The raw report is `architecture/capacity/fixtures-2026-11-17.json`.

## Fixture profiles

Each profile is one shop, with orders spread evenly over 36 months.

| Profile | Products | Variants | Orders | Line items | Customers | Inventory levels | Metafields | Product metric rows |
|---|---|---|---|---|---|---|---|---|
| Small | 500 | 1.5k | 5k | 7.5k | 3k | 3k | 1.5k | 2k |
| Medium | 5k | 15k | 50k | 75k | 30k | 30k | 15k | 20k |
| Large | 20k | 60k | 200k | 300k | 120k | 120k | 60k | 80k |
| Very large (the incident) | 70k | 210k | 500k | 750k | 300k | 420k | 210k | 280k |

Every profile also includes:
- **Order history:** refunds on 3% of orders and returns on 2%.
- **Products:** 3 metafields per product, metaobjects for 5% of products, and 4 metric windows per product.
- **Locations:** 3 locations, with 2 inventory levels per variant.
- **Webhooks:** 30 days of handled order webhooks, which hold no payload.
- **Sync records:** sync runs and checkpoints.

**Field widths:**
- product titles are 25–65 characters;
- description excerpts are 150–600 characters;
- metafield excerpts are 30–200 characters.

## Results

Storage of the commerce mirror, tables and indexes, after `VACUUM ANALYZE`:

| Profile | Mirror | Share of the 500 MB Free quota | Delete the shop (local) | Top products, 30 days (local) |
|---|---|---|---|---|
| Small | 7.9 MB | 1.6% | 0.1 s | 4 ms |
| Medium | 66 MB | 13% | 0.5 s | 12 ms |
| Large | 260 MB | 52% | 2.1 s | 36 ms |
| Very large | **733 MB** | **147%** | 6.2 s | 64 ms |

### Cost per entity

Storage grows linearly. These costs include indexes:

- **Per product: about 4.6 KB.** That covers the product, 3 variants, 6 inventory levels, 3 metafields and 4 metric rows.
- **Per order: about 0.9 KB.** That covers the order, 1.5 line items, a 0.6 share of a customer, refunds, returns and webhook history.
- **Fixed per shop:** 0.25 MB.

The import pre-flight check uses these figures.

### Where the very large shop's 733 MB goes

Heap is 482 MB and indexes are 250 MB.

| Table | Rows | MB | Bytes per row |
|---|---|---|---|
| order_line_items | 750k | 180 | 252 |
| orders | 500k | 168 | 352 |
| product_variants | 210k | 73 | 364 |
| metafields | 210k | 66 | 328 |
| inventory_levels | 420k | 64 | 159 |
| customers | 300k | 55 | 193 |
| product_metrics | 280k | 54 | 204 |
| products | 70k | 49 | 730 |
| webhook_events (30 days) | 42k | 15 | 383 |

### Supabase's own share

Measured read-only on staging: the staging database is 15.3 MB, of which our `public` schema is 2.4 MB. The rest, about 13 MB, is Postgres catalogs, auth, storage, cron and net. That leaves about 485 MB of the Free plan for application data.

## Findings

1. **The Phase 0 estimate was low.** The incident-scale shop needs 733 MB, not 350–450 MB.
   - It cannot fit on the Free plan at all.
   - With the 20–30% headroom that row updates and dead tuples need in practice, it needs about 0.9 GB.
2. **One large shop nears the upgrade threshold by itself.** It uses 260 MB (54% of the quota, counting Supabase's share). That is just under the 60% threshold.
3. **Medium shops fit.** Several could share the Free plan.
4. **Deletion is the slow operation.** Deleting a very large shop takes 6.2 s locally, in one transaction. On shared compute it may take several times longer and could exceed an API statement timeout. Phase 2 should delete large shops in batches across cron runs; the verification already tolerates a deletion that is retried.
5. **Reads are not the concern at this scale.** The analytical queries stay well under 100 ms locally, using the indexes.

## After task 12's optimisations (migration 0029)

Re-measured on the optimised schema with the same fixtures. The report is `architecture/capacity/fixtures-2026-11-18.json`.

| Profile | Mirror |
|---|---|
| Small | 7.1 MB |
| Medium | 58.2 MB |
| Large | 229.0 MB |
| Very large | 643.5 MB |

That is 10–12% less than above. Per entity:
- **Per product:** about 3.9–4.8 KB.
- **Per order:** about 0.80–0.87 KB.

The import pre-flight now projects with 4,100 bytes per product and 880 per order. Details are in `storage-optimisation.md`.

### Monthly summaries (migration 0030)

The retention summaries add about 180 bytes per product-month with sales, roughly 9–11% of the mirror over 36 months. For the very large shop that is 56.2 MB.

The pre-flight coefficients above do not include them yet; its 25% headroom covers them for now. Phase 2's pre-flight projects the retained 24 months of order lines plus the summaries (`retention-evaluation.md`).

## Candidates for the pre-Phase 2 optimisation review

> **Done.** Task 12 measured these candidates and decided them in `storage-optimisation.md`. The list below is kept as it stood before the review.

Under ADR 0002 (decision 2), these are reviewed before Phase 2 writes any rows. Each candidate is applied only once two things hold:
- its saving is measured against the fixtures;
- every reader of the data has been checked.

Anything that functionality, filtering, analytics or intelligence needs stays. Savings are for the very large profile.

| Candidate | Saving | Evidence so far |
|---|---|---|
| Integer shop key instead of the 16-byte shop UUID, in every row and index | 10–14% on the largest tables, roughly 70–85 MB in total | Measured on orders (168 → 144 MB) and line items (180 → 163 MB) |
| Inventory levels only where a shop really has several locations; otherwise the variant's own quantity | up to 64 MB | Estimate; depends on per-location readiness needs (Phase 3) |
| Metrics only for products with sales in the window, and only the windows the readers use | 20–40 MB | Estimate |
| Only the metafields a brief uses (one or two keys rather than three), with shorter excerpts | 20–40 MB | Estimate; depends on the evidence rules (Phase 6) |
| Indexes not used by any planned query | to be measured | Not yet reviewed |
| Product description excerpt of 300 characters instead of 600 | about 10 MB | Estimate; check the readiness and AI evidence readers first |
| `ship_city_raw` only when it differs from `ship_city`; `presentment_currency` only when it differs | about 10 MB | Estimate |

**Retention is not on this list.** Line-level order retention (24 instead of 36 months would save about 120 MB) is decided by task 11, not here.

**Moving history to R2 doesn't pay.** A separate analysis looked at keeping only hot data in Postgres and moving order history to R2. It found an extra 100–200 MB per merchant of this size, worth $0.01–0.03 a month on Pro. That doesn't justify a second storage system (ADR 0002).

## Supabase plan (ADR 0002, decision 6)

- **Staging and development: stay on Free.** Staging holds test data only.
- **Production: start on Pro, $25 a month.** The Phase 0 thresholds call for Pro before any of these happen:
  - the first merchant above about 10k products or 100k orders is onboarded, since their projected database would pass 60% of Free;
  - any paying merchant is onboarded, because Free has no automatic backups or point-in-time recovery;
  - the incident-scale merchant is onboarded, since 733 MB is over the Free quota.

  The merchants Omnitarget targets include incident-scale shops, so this comes to: start production on Pro.
- **Why Pro is enough:**
  - Its 8 GB of included disk holds about ten incident-scale shops as measured, and more after the optimisation review.
  - Monitoring (task 10) alerts at 60% and 75% of whatever quota applies.
  - The import pre-flight check refuses a full import that would pass 75%.
- **Decided: Pro is the intended production starting plan (ADR 0002).** The upgrade is approved separately during the production release. Nothing is upgraded before then.

## Phase 3 additions (measured on staging)

**Task 2 (0044, catalog completeness).** Average row sizes on staging, for rows read with Phase 3's fields against the same shop's older rows:

| | Before 0044 | With 0044's fields |
|---|---|---|
| omni-beta product (no images, not on the Online Store) | 503 bytes | 657 bytes |
| Dev-store product (most with an image) | — | 577 bytes |
| omni-beta variant | 196 bytes | 211 bytes |

- **Per product:** the new fields cost about 150 bytes without an image and about 300 bytes with one. The image URL, alt text and Online Store URL take most of it.
- **Incident-scale shop (70k products, 210k variants):** about +21 MB for products and +5 MB for variants, roughly 4% of the 643.5 MB measured after the storage review.
- **Description:** the excerpt stays at 600 characters (storage review).
- **Metafields:** variant metafields add rows only where a shop defines them.
- **Metaobjects:** only those referenced are stored, each capped at 6 KB of field values. Shops typically have hundreds, not millions.

**Task 3 (0046, inventory and fulfilment).**
- An inventory level grows from 76 to 101 bytes with every quantity state stored. That is about +10 MB for the incident-scale shop's 420k levels (under 2%).
- Locations add a few bytes each, and shops have few.

**Task 4 (0047, returns and restrictions).**
- A refund line item takes 78 bytes.
- An order grows by about 12 bytes (a flag and a short return status); omni-beta's orders read with these fields average 198 bytes against 176, a difference that also includes fields changed since the last import. Each order line grows by about 4 bytes for its restrictions.
- A shop with 500k orders and 5% of them refunded (one line each) adds about 2 MB of refund lines.
