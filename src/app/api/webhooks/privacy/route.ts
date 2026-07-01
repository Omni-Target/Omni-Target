/**
 * /api/webhooks/privacy
 *
 * Shopify Mandatory Privacy / GDPR compliance endpoint. The actual logic
 * (HMAC verification, topic handling, shop/redact data deletion) is shared with
 * /api/webhooks/gdpr in `@/lib/shopify-webhooks` so there is a single source of
 * truth. This route is excluded from Clerk auth in proxy.ts.
 */
import { handleShopifyPrivacyWebhook } from "@/lib/shopify-webhooks";

export async function POST(request: Request) {
  return handleShopifyPrivacyWebhook(request);
}
