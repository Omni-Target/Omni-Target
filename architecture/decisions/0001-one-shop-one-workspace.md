# ADR 0001: One Shopify shop, one Omnitarget workspace

Status: Accepted, 2026-11-09.

Supersedes the earlier Phase 1 proposal that let several Omnitarget accounts hold active memberships on one shop.

## Context

Today each Omnitarget account has one `user_integrations` row, and nothing stops several accounts connecting the same Shopify store. Shopify keeps one current offline token per app and store, so those accounts hold competing credentials. Purchases made on a shared store also have no reliable link to the account that paid.

## Decision

### Identity

- A **shop** is identified by Shopify's immutable shop ID. Its `myshopify.com` domain is a unique attribute that can change.
- A **workspace** is the Omnitarget account that owns data: credits, campaigns, billing history and integrations.
- A workspace has exactly one owner, a verified Clerk user. One Clerk user may own several workspaces, which never share balances, campaigns or credentials.
- Deleting a workspace never deletes its owner's Clerk user. Uninstalling one store affects only that store's workspace; the owner's login and other workspaces are untouched.

### Ownership

- One shop is bound to at most one workspace at a time, and one workspace to at most one shop. Both rules are enforced by database constraints.
- A binding stays in force while its workspace is `pending_deletion` or `deletion_processing`, so nobody else can claim that shop.
- Every binding, release and transfer is kept as history.
- Campaigns are visible only to their creator. Binding a shop grants no access to another workspace's data.

### Provisioning

1. Shopify's install callback is authenticated and its state validated.
2. The shop's immutable ID is read with the new token.
3. If no binding exists, the shop is bound to a workspace of the verified Clerk user. That is a new workspace, unless the user's selected workspace has no shop yet.
4. The operation is idempotent: a repeated callback cannot create a second workspace or binding.

The store's contact email is never used to identify the installer or to grant ownership.

### Connection rules

| Situation | Outcome |
|---|---|
| Owner disconnects | Credential cleared; workspace and binding kept |
| Owner reconnects, including after temporary disconnection | Same workspace restored |
| Another account connects a bound shop | Rejected; the binding is never overwritten |
| Another account connects a shop pending deletion | Rejected |
| Owner's deletion completes | Binding released; a later install provisions a new workspace |
| Legitimate change of business owner | Explicit, verified ownership transfer only |

### Lifecycle

Workspace states: `active`, `disconnected`, `pending_deletion`, `deletion_processing`, `deleted`.

- **`app/uninstalled`:** synchronisation and new shop operations stop, background work is cancelled, the Shopify credential is cleared and the workspace becomes `pending_deletion`. The binding is kept.
- **Reinstall before deletion completes:** the shop ID finds the original workspace, which is restored. No duplicate workspace, balance or purchase transfer.
- **`shop/redact`:** Shopify sends it 48 hours after uninstall. It does not send it if the merchant reinstalls before it is triggered. Once any compliance webhook is received, its action must be completed within 30 days. On receipt, the workspace moves to `deletion_processing`, Shopify-derived data is deleted or anonymised, then the workspace becomes `deleted` and the binding is released.
- **Recovery window:** 48 hours by default, matching Shopify's timing.
- **Timestamps:** uninstall, reinstall and every compliance webhook's receipt are recorded separately.
- **A received request is never silently discarded.** A reinstall is not assumed to cancel a redaction request already issued or received. If one arrives for a workspace that was restored in the meantime, it is recorded with its 30-day deadline and as a redaction after reinstall, reconnection is refused, and the deletion workflow completes and verifies the deletion. Only then can the merchant's next installation provision a new workspace. This lifecycle is to be confirmed on the Shopify development store.

Uninstall and `shop/redact` are separate events and are never treated as the same thing.

### Ownership transfer

A transfer is requested by a verified Clerk user. That user proves control of the store by completing Shopify OAuth for that shop, and the current owner approves.

On completion, the old binding is released with reason `ownership_transferred` and the shop is bound to the new owner's workspace.

Credits, private campaigns, generated content and workspace-specific financial history stay with the original workspace. The new workspace establishes its own authorisation and synchronises its own shop data. Nothing private moves implicitly.

Completing OAuth alone never transfers ownership.

### Credits

- Credits belong to a workspace. There are no shared shop wallets.
- Every change goes through one transactional operation that writes an append-only, idempotent ledger and the balance together. Each entry records the workspace, actor or purchaser, shop context, provider, exact external reference and idempotency key.
- A purchase belongs to the workspace that started it. Billing creation records the purchaser and workspace against the charge.
- Reconciliation uses that record. Every new purchase has one.
- A legacy purchase without that record may be attributed through a historical binding only if the binding is verified, its start and end times are reliable, and the purchase time is reliable and falls unambiguously within that interval. Otherwise it stays **unattributed** for review.
- A purchase is never credited to whichever account has a working token or loads a page, and historical purchases never move to a newly provisioned workspace.
- Unlimited access is an entitlement, kept separate from the balance.

## Consequences

- Competing credentials and cross-account purchase attribution disappear by construction.
- Legacy accounts that share a store cannot be merged automatically. Their claims are recorded, and they stay unresolved until reviewed (see `architecture/phase-1-data-model.md`).
- Tenant isolation rests on authenticated server context, scoped repositories and database constraints. The service role bypasses RLS, so RLS on its own is not enough.

## Open policy items, for approval

1. **Unused paid credits** when a workspace is permanently deleted: forfeit, refund on request, or keep claimable for a set period. Until decided, they are kept unchanged in the ledger and the decision is isolated in one place.
2. **Transfer when the current owner cannot approve.** For example, a waiting period plus confirmation through the store's registered owner email, combined with OAuth proof.
3. **Clerk account deletion while the account owns workspaces.** Today account deletion removes the user's legacy data but leaves their workspaces and bindings, so a still-installed store stays bound to an owner who no longer exists until Shopify sends `shop/redact` or item 2 provides a path. Options: close the user's workspaces as part of account deletion, or refuse account deletion while a workspace holds an installed store.

Settled on 2026-11-09: the recovery window is 48 hours by default, and a received compliance request is never discarded. Still to verify on the development store: uninstall, reinstall and redaction timing.
