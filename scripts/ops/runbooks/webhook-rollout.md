# Webhook rollout for existing installations (SEC-09, ING-05)

New installs register `orders/paid` and `app/uninstalled` per shop, through the
Admin API, during OAuth. Shops installed before `app/uninstalled` was added do
not have that subscription, so an uninstall would not revoke their stored
credentials.

Do not rely on `shopify.app.toml` for this. Shopify's documentation does not
confirm that `shopify app deploy` adds subscriptions to shops that are already
installed, and a second, app-wide subscription could deliver the same event
twice. `shopify app webhook trigger` tests delivery only; it proves nothing about
what a shop is subscribed to.

## The reconcile route

`GET /api/cron/ensure-webhooks`, protected by `CRON_SECRET`.

- By default it only reports. `?apply=true` creates the missing subscriptions.
- It never removes a subscription.
- It handles 25 accounts per call. Repeat with `?cursor=<nextCursor>` until
  `nextCursor` is `null`.
- Responses carry masked shop names and status only.
- It is safe to run again: complete shops are left alone.

| Status | Meaning |
|---|---|
| `complete` | Both topics exist at this deployment's address |
| `missing` | Dry run: the listed topics would be created |
| `repaired` | All missing topics now appear in Shopify's own list |
| `partial` | At least one topic is still absent after creating (`reason` has Shopify's status) |
| `skipped` | No usable token (`reason` says why) |
| `failed` | Shopify or the database could not be reached |

## Token safety

Listing a shop's subscriptions needs a valid token, and an expired token is
refreshed first. Shopify refresh tokens are single-use.

- **Production:** refreshing is normal and uses the existing per-shop lock.
- **Staging or preview:** tokens may be mirrored from production. Refreshing one
  would rotate the real merchant's token. The route refuses to run on any
  non-production Vercel deployment unless `SHOPIFY_TOKEN_REFRESH_DISABLED=true`.
  With the guard on, shops with expired tokens are reported as `skipped`.

## Procedure

Production steps need separate approval. The route must be deployed first.

1. Dry run, following `nextCursor` to the end. Record the `summary` of each page.

   ```sh
   curl -sS -H "Authorization: Bearer $CRON_SECRET" \
     "https://<app-host>/api/cron/ensure-webhooks"
   ```

2. Review the shops listed as `missing`, `skipped` and `failed`.
3. Apply, again following `nextCursor`:

   ```sh
   curl -sS -H "Authorization: Bearer $CRON_SECRET" \
     "https://<app-host>/api/cron/ensure-webhooks?apply=true"
   ```

4. Run the dry run again. Every shop that had a usable token must be `complete`.

## Verifying independently

The route's own report is not proof. Also confirm:

1. On a test store: list subscriptions directly with
   `GET /admin/api/<version>/webhooks.json` and check both topics and the address.
2. On a test store: uninstall the app and confirm its token columns are cleared
   and `shopify_uninstalled_at` is set.
3. In the Shopify Dev Dashboard logs: confirm a delivery for that uninstall and
   that the response was 200.

Shops that stay `skipped` with `reauth_required` have no working token. They get
the subscriptions when the merchant next connects.
