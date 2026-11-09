# Phase 1 data model and migration design

Implements `architecture/decisions/0001-one-shop-one-workspace.md`. Built and tested on staging. Production is reconciled at the end of the programme, not before.

## Conventions

- New tables have RLS enabled, with no grants to `anon` or `authenticated`. Only `service_role` and SQL functions reach them.
- The service role bypasses RLS. Isolation therefore also relies on authenticated server context, scoped repositories and SQL functions that check ownership.
- States use `text` with `CHECK` constraints, so they can evolve with forward-only migrations.
- Shopify IDs are stored as `bigint`.

## Ownership (migration 0018, implemented)

| Table | Key columns | Constraints |
|---|---|---|
| `workspaces` | `id`, `owner_clerk_user_id`, `status`, `status_changed_at`, `last_connected_at`, `uninstalled_at`, `deletion_requested_at`, `recovery_ends_at`, `deleted_at`, `legacy_user_integration_id` | `status` in `active`, `disconnected`, `pending_deletion`, `deletion_processing`, `deleted`; `deleted_at` set exactly when `deleted`. `legacy_user_integration_id` unique. Index on owner for non-deleted rows. One Clerk user may own several |
| `credit_accounts` | `workspace_id`, `balance`, `updated_at` | Created with each workspace by trigger. `balance >= 0`. The ledger that changes it arrives in 0020 |
| `shops` | `id`, `shopify_shop_id`, `myshopify_domain`, `name`, `domain_changed_at` | `shopify_shop_id` unique, not null, positive. `myshopify_domain` unique and must be a lower-case `*.myshopify.com` host; it follows Shopify when the domain changes. Created only from an authenticated installation, never from a legacy domain |
| `shop_bindings` | `shop_id`, `workspace_id`, `bound_at`, `bound_by_clerk_user_id`, `released_at`, `release_reason`, `transfer_id` | Unique `shop_id` and unique `workspace_id` where `released_at is null`. `release_reason` in `deletion_completed`, `ownership_transferred`, set exactly when released. Released rows are history and are never deleted |
| `workspace_events` | `workspace_id`, `shop_id`, `event`, `actor_clerk_user_id`, `source`, `occurred_at`, `recorded_at`, `details` | Append-only (trigger). Events: `provisioned`, `connected`, `connect_rejected`, `reconnected`, `restored`, `disconnected`, `uninstalled`, `uninstall_stale`, `redact_received`, `redact_after_reinstall`, `deletion_started`, `deletion_verified`, `deleted`, `legacy_claim_*`, `transfer_*` |
| `shop_lifecycle_events` | `topic`, `event_key`, `shopify_shop_id`, `shop_domain`, `triggered_at`, `received_at`, `workspace_id`, `outcome` | Unique (`topic`, `event_key`): a repeated delivery is recognised. Shopify's trigger time and our receipt time are kept apart |
| `compliance_requests` | `lifecycle_event_id`, `topic`, `shopify_shop_id`, `shop_domain`, `workspace_id`, `received_at`, `due_at`, `status`, `resolution`, `completed_at` | One per received compliance webhook, kept after completion. `due_at` is receipt plus 30 days. `status` in `open`, `processing`, `completed` |
| `workspace_deletions` | `workspace_id`, `compliance_request_id`, `status`, `attempts`, `last_error`, `due_at`, `verification` | One open deletion per workspace. `failed` stays open and is retried |
| `ownership_transfers` | `shop_id`, `from_workspace_id`, `to_workspace_id`, `requested_by_clerk_user_id`, `reason`, `status`, `requested_at`, `shopify_verified_at`, `approved_at`, `approved_by_clerk_user_id`, `completed_at`, `closed_at`, `expires_at` | `status` in `requested`, `verified`, `approved`, `completed`, `cancelled`, `expired`. One open transfer per shop. `to_workspace_id` stays null until completion creates the workspace, unless the requester named an empty one. Expires after 7 days |
| `legacy_shop_claims` | `legacy_source`, `legacy_row_id`, `clerk_user_id`, `claimed_domain`, `workspace_id`, `status`, `shop_id`, `confirmed_at`, `reviewed_by`, `review_note` | Unique (`legacy_source`, `legacy_row_id`). `status` in `provisional`, `contested`, `confirmed`, `unresolved`, `rejected`; `shop_id` set exactly when `confirmed` |

`campaigns.workspace_id` is added, nullable. The other tenant tables get theirs in 0022.

A shop row keeps only its ID and domain after deletion, as the identity record that financial history refers to.

### Access

All ten tables have RLS enabled and no grants to `anon` or `authenticated`. `service_role` may read them and nothing else. Every change goes through the functions below, which run with their owner's rights (`security definer`, `search_path = public, pg_temp`) and are the only writers. `service_role` may execute the public functions; internal helpers (`log_workspace_event`, `find_shop`, `shop_has_open_redaction`) are not granted to it. Real Postgres tests run every function as `service_role`.

### Lifecycle operations

Each is one SQL function and one transaction. Installation and transfer completion take a transaction-scoped advisory lock per Shopify shop ID and per domain, so concurrent callbacks serialise; the partial unique indexes are the final guard.

| Operation | Effect |
|---|---|
| `shop_connection_preflight(domain, actor)` | Read-only, before the OAuth code is exchanged: refuses another owner's shop, a shop under redaction and a store under a legacy claim. A refused account therefore never exchanges a code, which would retire the owner's token |
| `bind_shop_for_install(shopify_shop_id, domain, actor, selected_workspace, name)` | Creates or updates the shop by its ID (a changed domain is followed; a domain held by another shop ID is refused). Owner's own binding: `already_bound`, or restores a `disconnected` (`reconnected`) or `pending_deletion` (`restored`) workspace. Another owner's binding, an open redaction or `deletion_processing`: refused and logged. Unbound: a legacy claim decides who may bind; otherwise the actor's chosen workspace (theirs, active and unbound) or a new one. Idempotent |
| `disconnect_workspace(workspace, actor)` | Owner only. Sets `disconnected` and keeps the binding; the app clears the stored credential |
| `begin_uninstall(shopify_shop_id, domain, event_key, triggered_at)` | Records the delivery once. Sets `pending_deletion`, `uninstalled_at` (Shopify's trigger time) and `recovery_ends_at` (+48 hours), cancels open transfers, keeps the binding. An uninstall triggered before the latest reconnection is `stale` and changes nothing. A repeat returns the first delivery's outcome |
| `record_shop_redact(shopify_shop_id, domain, event_key, triggered_at)` | Records the delivery and a compliance request due in 30 days, then moves the bound workspace to `deletion_processing` and opens a deletion. A request arriving after a reinstall is acted on, never skipped: it is logged as `redact_after_reinstall`, reconnection is refused until the deletion completes, and the merchant's next installation then starts a new workspace. A shop with no workspace keeps an open request handled by `process_unbound_shop_redact` |
| `process_workspace_deletion(deletion)` | Redacts Shopify-derived data (`redact_shop_data`), deletes the workspace's campaigns, then verifies nothing naming the shop remains. Only a verified deletion marks the workspace `deleted`, releases the binding as `deletion_completed` and completes its compliance requests. A failure is kept as `failed` with its error and retried by `/api/cron/process-deletions` |
| `record_customer_compliance(topic, …)` | Records `customers/redact` and `customers/data_request` once and completes them as `no_customer_data_held` |
| `request_` / `verify_` / `approve_` / `complete_` / `cancel_ownership_transfer` | Request names the store. Verification is the requester completing Shopify's authorization for the shop, without a code exchange. Approval is by the current owner only, after verification. Completion is the requester's own installation: the old binding is released as `ownership_transferred`, the new one created. Credits, campaigns and history stay with the original workspace |
| `register_legacy_account` / `review_legacy_claims` | See the legacy migration below |
| `workspace_for_actor`, `list_workspaces`, `workspace_credit_balance`, `campaign_for_actor` | Reads for an authenticated actor. Another user's workspace, or one being deleted, raises `workspace_access_denied`. A campaign is visible only to its creator, in its own workspace |
| `workspace_can_operate(workspace)`, `shop_operations_allowed(domain)` | True only for an `active` workspace that holds its binding and has no open deletion. Every Shopify token is issued through this check, so disconnected, uninstalled and deleting workspaces start no sync or webhook work. A shop not yet modelled keeps legacy behaviour |

Shop data deletion, workspace closure and Clerk identity deletion stay separate. Deleting a workspace never deletes the owner's Clerk identity, their other workspaces or anyone else's data, and unused credits are left untouched pending the open policy decision.

### Transitional behaviour until tasks 4 to 6

- `user_integrations` holds one Shopify credential per Clerk user. Connecting a second store replaces it, so the previous store's workspace is disconnected (binding, data and credits kept; reconnecting restores it). Task 4 moves credentials to `shop_credentials`, after which an account can keep several stores connected.
- Balances still come from `user_integrations`. `credit_accounts` starts at zero until the ledger and opening balances of task 5.
- New campaigns are not yet attributed to a workspace (0022). Deletion removes attributed campaigns and, through the legacy redaction, unattributed ones for the shop; a campaign attributed to another workspace is never touched.
- The legacy redaction still clears generation receipts and Meta events per Clerk user rather than per workspace.

## Credentials

| Table | Key columns | Constraints |
|---|---|---|
| `shop_credentials` | `shop_id`, `kind` (`access` or `refresh`), `ciphertext`, `iv`, `auth_tag`, `key_version`, `expires_at`, `scopes` | Primary key (`shop_id`, `kind`). One current credential per shop |
| `shop_refresh_locks` | `shop_id`, `holder`, `locked_until` | Replaces the per-user refresh lock |
| `workspace_meta_connections` | `workspace_id`, ad account, pixel, business and page IDs, `connected_at` | One per workspace |
| `workspace_meta_credentials` | `workspace_id`, `kind` (`user` or `page`), encrypted fields as above | Primary key (`workspace_id`, `kind`) |

- **Encryption:** AES-256-GCM, a fresh 12-byte nonce per write, the authentication tag stored with it, and the key version recorded.
- **Additional authenticated data** binds each ciphertext to its row, for example `shop_credentials:<shop_id>:refresh`, so a value copied elsewhere fails to decrypt.
- **Keys** come from `APP_ENCRYPTION_KEY` and `APP_ENCRYPTION_KEY_VERSION`, with older keys kept only for decryption.
- **Token values never go into history.** Issue, refresh and clear events are recorded in `workspace_events` as metadata only.

## Credits

| Table | Key columns | Constraints |
|---|---|---|
| `credit_accounts` | `workspace_id`, `balance`, `updated_at` | `balance >= 0`. Changed only by the canonical operation |
| `credit_ledger` | `id`, `workspace_id`, `entry_type`, `quantity`, `balance_after`, `actor_clerk_user_id`, `shop_id`, `provider`, `external_reference`, `idempotency_key`, `reason`, `metadata`, `created_at` | Append-only: a trigger and revoked grants prevent update and delete. `idempotency_key` unique. One entry per (`provider`, `external_reference`, `entry_type`) for purchases, subscription grants, refunds and reversals. One free grant per workspace and per shop |
| `credit_entitlements` | `workspace_id`, `kind` (`unlimited`), `starts_at`, `ends_at`, `provider`, `external_reference`, `idempotency_key` | Kept separate from the balance |
| `purchase_intents` | `id`, `workspace_id`, `shop_id`, `purchaser_clerk_user_id`, `provider`, `plan_key`, `kind`, `external_charge_id`, `status` | Written at billing creation. Unique (`provider`, `external_charge_id`) |
| `provider_purchases` | `provider`, `external_id`, `kind`, `shop_id`, `workspace_id`, `intent_id`, `attribution`, `review_status`, provider status, amount, currency, test flag, provider date, `ledger_entry_id` | Unique (`provider`, `external_id`). `attribution` in `intent`, `binding_period`, `legacy_record`, `unattributed` |
| `billing_sync_state` | `shop_id`, `cursor`, `last_completed_at`, `status` | Lets reconciliation page through full purchase history and resume |

**Entry types:** `opening_balance`, `purchase`, `free_grant`, `consumption`, `adjustment`, `refund`, `reversal`, `subscription_grant`.

**Canonical operation.** `apply_credit_mutation(workspace, type, quantity, idempotency_key, actor, shop, provider, external_reference, reason, metadata, payment)`:

- Locks the credit account.
- Returns the existing result on a repeated idempotency key.
- Refuses a negative balance.
- Writes the ledger entry, balance and optional payment record in one transaction.

`grant_purchase` wraps it to also update the purchase and intent. `commit_brief_generation` debits through it. The old functions delegate to it during the transition, and the JavaScript fallbacks that write balances directly are removed.

**Reconciliation** pages through Shopify purchases with a stored cursor. Attribution comes from the purchase intent, which every new purchase has. A legacy purchase can use a historical binding only when the binding is verified, its start and end times are reliable, and the purchase time falls unambiguously inside it. Otherwise it is recorded as unattributed for review.

**Subscriptions** are granted once per billing period, keyed by subscription ID and period start, never once per subscription ID.

No transaction stays open across a Shopify or AI call.

## Tenant data

`workspace_id` is added to `campaigns`, `campaign_brief_versions`, `brief_generation_receipts`, `payments`, `credit_usage` and `capi_events`. It starts nullable and is filled by the legacy migration.

Campaigns stay creator-only. Queries require both the workspace and the creator.

The workspace comes from server-side context: the session user plus their selected workspace, checked for ownership and status. A browser-supplied workspace, shop or user ID is never trusted.

## Legacy migration from `user_integrations`

Run as a dry run first, which writes a report. Then it is applied per account, idempotently, recording what was migrated, skipped and why.

1. **One workspace per legacy row**, owned by that row's Clerk user. Accounts are never merged. Each row's campaigns, payments and history move with it.
2. **Shop identity.** Legacy rows store no Shopify shop ID, so no shop is bound at migration time and no shop row is created from a domain. `register_legacy_account(legacy_row, clerk_user, domain)` (0018) creates the row's workspace and a claim, idempotently:
   - A domain claimed by one legacy row is `provisional`. Only that account may bind it, at its next authenticated connection, which records the shop ID and confirms the claim.
   - A domain claimed by several rows is `contested`. Every connection attempt is refused until `review_legacy_claims` keeps one claim as provisional (still confirmed only by that account's own connection) and rejects the others, with reviewer and note.
   - A missing or invalid domain is `unresolved` and binds nothing.
3. **Credentials.** A credential is migrated only when its shop is bound and the credential is shown to work. Others are recorded as retired, by metadata only.
4. **Opening balances** equal current balances, to preserve them. Each is compared with what the records explain (free grant, plus payment grants, minus usage, plus adjustments). Differences go to `credit_migration_review`. No historical transaction is invented.
5. **Purchases.** Known claimed purchases are recorded in `provider_purchases` against their existing account. A new workspace never inherits an older purchase.
6. **Orphans**, such as payments or usage with no account, are recorded in `legacy_orphans` and not attached anywhere.

Mapping tables: `legacy_shop_claims` (0018), and `legacy_account_map`, `credit_migration_review`, `legacy_orphans` (0021).

## Migration sequence

Historical files `0001` to `0017` are kept unchanged. A schema baseline taken at `0017` lets a fresh database be built from baseline plus later migrations. Production is reconciled against the finished set at release.

| Migration | Contents |
|---|---|
| `0018_workspaces_and_shop_bindings` | Workspaces, credit accounts, shops, bindings, events, lifecycle events, compliance requests, deletions, transfers, legacy claims, `campaigns.workspace_id`, and their functions (implemented) |
| `0019_encrypted_credentials` | Shop and Meta credentials, refresh locks |
| `0020_credit_ledger` | Accounts, ledger, entitlements, intents, provider purchases, sync state, canonical functions |
| `0021_legacy_mapping` | Mapping and review tables |
| `0022_workspace_columns` | `workspace_id` on tenant tables, with indexes |
| `0023_commerce_model` | Products, variants, inventory, locations, orders, line items, minimal customers, returns, metafields, metaobject definitions and metaobjects, shop settings and access |
| `0024_sync_inbox_metrics` | Sync runs and checkpoints, webhook inbox, metrics |
| `0025_capacity_snapshots` | Daily size snapshots |
| `0026_brief_evidence_archive` | Archive tracking for trimmed briefs |

Every migration has a down script, runs against a database that already holds data, and changes no existing rows. Data moves only through the dry-run-first migration scripts.

The contract step, which removes legacy token, credit and snapshot columns, comes after Phase 2. It is part of the release plan and needs its own approval.
