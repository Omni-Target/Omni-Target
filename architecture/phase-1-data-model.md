# Phase 1 data model and migration design

Implements `architecture/decisions/0001-one-shop-one-workspace.md`. Built and tested on staging. Production is reconciled at the end of the programme, not before.

## Conventions

- New tables have RLS enabled, with no grants to `anon` or `authenticated`. Only `service_role` and SQL functions reach them.
- The service role bypasses RLS. Isolation therefore also relies on authenticated server context, scoped repositories and SQL functions that check ownership.
- States use `text` with `CHECK` constraints, so they can evolve with forward-only migrations.
- Shopify IDs are stored as `bigint`.

## Ownership

| Table | Key columns | Constraints |
|---|---|---|
| `workspaces` | `id`, `owner_clerk_user_id`, `status`, `deletion_requested_at`, `deletion_due_at`, `deleted_at`, `legacy_user_integration_id` | `status` in `active`, `disconnected`, `pending_deletion`, `deletion_processing`, `deleted`. `legacy_user_integration_id` unique. Index on owner for non-deleted rows |
| `shops` | `id`, `shopify_shop_id`, `myshopify_domain`, `primary_domain`, `name`, `currency`, `country_code` | `shopify_shop_id` unique and not null. `myshopify_domain` unique, lowercase, and updateable |
| `shop_bindings` | `id`, `shop_id`, `workspace_id`, `bound_at`, `bound_by_clerk_user_id`, `released_at`, `release_reason` | Unique `shop_id` where `released_at is null`; unique `workspace_id` where `released_at is null`. Released rows are history |
| `workspace_events` | `workspace_id`, `shop_id`, `event`, `actor_clerk_user_id`, `source`, `details`, `at` | Append-only audit: provisioned, connected, reconnect, rejected, disconnected, uninstalled, restored, redaction, deleted, transfer events |
| `ownership_transfers` | `id`, `shop_id`, `from_workspace_id`, `to_workspace_id`, `requested_by_clerk_user_id`, `status`, `oauth_verified_at`, `approved_at`, `completed_at` | `status` in `requested`, `verified`, `approved`, `completed`, `cancelled`, `expired`. One open transfer per shop |

A shop row keeps only its ID and domain after deletion, as the identity record that financial history refers to.

### Lifecycle operations

Each is a SQL function, and each is one transaction.

| Operation | Effect |
|---|---|
| `bind_shop_for_install(shopify_shop_id, domain, actor, selected_workspace)` | No binding: binds to the actor's empty selected workspace, or a new one. Owner's own binding: restores it. Another owner's binding or `deletion_processing`: rejected and logged. Repeated calls give the same result |
| `disconnect_workspace(workspace, actor)` | Clears the credential, sets `disconnected`, keeps the binding |
| `begin_uninstall(shopify_shop_id)` | Sets `pending_deletion`, clears the credential, cancels sync runs, keeps the binding |
| `process_shop_redact(shopify_shop_id)` | `pending_deletion`: moves to `deletion_processing`, redacts, then `deleted` and releases the binding. A workspace restored since the uninstall is left alone and the event is recorded for review |
| `complete_ownership_transfer(transfer)` | Releases the old binding as `ownership_transferred` and binds the new owner's workspace. Credits and campaigns stay put |

Background work checks `workspace_can_operate(workspace, shop)` before every step: the workspace is `active` and still holds the binding.

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

**Reconciliation** pages through Shopify purchases with a stored cursor. Attribution comes from the purchase intent, then from the binding that covered the purchase date, and otherwise the purchase is recorded as unattributed for review.

**Subscriptions** are granted once per billing period, keyed by subscription ID and period start, never once per subscription ID.

No transaction stays open across a Shopify or AI call.

## Tenant data

`workspace_id` is added to `campaigns`, `campaign_brief_versions`, `brief_generation_receipts`, `payments`, `credit_usage` and `capi_events`. It starts nullable and is filled by the legacy migration.

Campaigns stay creator-only. Queries require both the workspace and the creator.

The workspace comes from server-side context: the session user plus their selected workspace, checked for ownership and status. A browser-supplied workspace, shop or user ID is never trusted.

## Legacy migration from `user_integrations`

Run as a dry run first, which writes a report. Then it is applied per account, idempotently, recording what was migrated, skipped and why.

1. **One workspace per legacy row**, owned by that row's Clerk user. Accounts are never merged. Each row's campaigns, payments and history move with it.
2. **Shop identity.** Legacy rows store no Shopify shop ID, so no shop is bound at migration time.
   - A store domain claimed by one legacy row becomes a `sole_claimant` reservation. Only that workspace may bind it, at its next authenticated connection, which also confirms the shop ID.
   - A domain claimed by several rows becomes `contested`. Every connection attempt is rejected until a reviewer resolves it.
3. **Credentials.** A credential is migrated only when its shop is bound and the credential is shown to work. Others are recorded as retired, by metadata only.
4. **Opening balances** equal current balances, to preserve them. Each is compared with what the records explain (free grant, plus payment grants, minus usage, plus adjustments). Differences go to `credit_migration_review`. No historical transaction is invented.
5. **Purchases.** Known claimed purchases are recorded in `provider_purchases` against their existing account. A new workspace never inherits an older purchase.
6. **Orphans**, such as payments or usage with no account, are recorded in `legacy_orphans` and not attached anywhere.

Mapping tables: `legacy_account_map`, `legacy_shop_claims`, `credit_migration_review`, `legacy_orphans`.

## Migration sequence

Historical files `0001` to `0017` are kept unchanged. A schema baseline taken at `0017` lets a fresh database be built from baseline plus later migrations. Production is reconciled against the finished set at release.

| Migration | Contents |
|---|---|
| `0018_workspaces_and_shop_bindings` | Workspaces, shops, bindings, events, transfers, lifecycle functions |
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
