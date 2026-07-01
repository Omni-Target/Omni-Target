/**
 * /api/webhooks/gdpr
 *
 * Alias of the Shopify mandatory privacy webhook endpoint. Shares all logic
 * with /api/webhooks/privacy via `@/lib/shopify-webhooks`. Kept as a separate
 * route so either URL can be registered in the Partner Dashboard. Excluded from
 * Clerk auth in proxy.ts.
 */
import { handleShopifyPrivacyWebhook } from "@/lib/shopify-webhooks";

export async function POST(request: Request) {
  return handleShopifyPrivacyWebhook(request);
}
