import { after } from "next/server";
import { verifyShopifyHmac } from "@/lib/verify-shopify-hmac";
import { createLogger } from "@/lib/logger";
import { captureBackgroundFailure } from "@/lib/observability/capture";
import { lifecycleEventKey, parseShopifyShopId, parseTriggeredAt, webhookShopDomain } from "@/modules/workspaces/lifecycle";
import {
  processUnboundShopRedact,
  processWorkspaceDeletion,
  recordCustomerCompliance,
  recordShopRedact,
  type RedactResult,
} from "@/modules/workspaces/repository";

const log = createLogger("shopify-privacy-webhook");

// The three Shopify-mandated GDPR/privacy topics.
const PRIVACY_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

type PrivacyTopic = (typeof PRIVACY_TOPICS)[number];

function isPrivacyTopic(topic: string | null): topic is PrivacyTopic {
  return !!topic && (PRIVACY_TOPICS as readonly string[]).includes(topic);
}

/**
 * Shared handler for Shopify's mandatory GDPR/privacy webhooks. Both
 * `/api/webhooks/privacy` and `/api/webhooks/gdpr` delegate here so HMAC
 * verification and the compliance workflow live in exactly one place.
 *
 * Every authenticated request is recorded, with Shopify's trigger time, our
 * receipt time and its 30-day deadline, before Shopify gets its 200. If it
 * cannot be recorded the answer is 500 and Shopify retries; a retry is
 * recognised by its delivery id. A request is never dropped, including a
 * shop/redact that arrives after the merchant reinstalled.
 *
 *   • customers/data_request, customers/redact: recorded and resolved at once.
 *     Omni Target keeps no customer-level records: store snapshots hold
 *     aggregates and Meta send logs hold order ids and values (SEC-09).
 *   • shop/redact: starts the workspace deletion workflow, which deletes the
 *     shop's data, verifies nothing is left and only then releases the shop.
 *     Work that does not finish here is retried by /api/cron/process-deletions.
 *
 * Both routes are excluded from Clerk auth in proxy.ts so Shopify's servers
 * (no session) can reach them; authenticity is verified here via the HMAC.
 */
export async function handleShopifyPrivacyWebhook(
  request: Request,
): Promise<Response> {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    log.error("SHOPIFY_WEBHOOK_SECRET is not configured");
    return Response.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  // The HMAC is computed over the exact raw bytes — read before any parsing.
  const rawBody = await request.text();
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic");
  const headerShop = request.headers.get("x-shopify-shop-domain");

  if (!hmacHeader) {
    log.warn("Missing X-Shopify-Hmac-SHA256 header", { shop: headerShop ?? "unknown" });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await verifyShopifyHmac(rawBody, hmacHeader, secret))) {
    log.warn("HMAC verification failed", { shop: headerShop ?? "unknown", topic });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Unknown/missing topic: acknowledge with 200 so Shopify doesn't retry —
  // there's simply nothing for us to act on.
  if (!isPrivacyTopic(topic)) {
    log.warn("Unknown or missing topic", { topic, shop: headerShop ?? "unknown" });
    return Response.json({ received: true, topic: topic ?? null }, { status: 200 });
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null;
  }
  const shop = webhookShopDomain(payload, headerShop);
  if (!shop) {
    log.warn("Compliance webhook without a valid shop domain", { topic });
    return Response.json({ error: "Invalid shop domain" }, { status: 400 });
  }

  const event = {
    shopifyShopId: parseShopifyShopId((payload as { shop_id?: unknown } | null)?.shop_id),
    domain: shop,
    eventKey: lifecycleEventKey({ webhookId: request.headers.get("x-shopify-webhook-id"), topic, domain: shop, rawBody }),
    triggeredAt: parseTriggeredAt(request.headers.get("x-shopify-triggered-at")),
  };

  try {
    if (topic === "shop/redact") {
      const recorded = await recordShopRedact(event);
      log.info("shop/redact recorded", { shop, outcome: recorded.outcome });
      after(() => runShopRedaction(recorded, shop));
    } else {
      const recorded = await recordCustomerCompliance(topic, event);
      log.info(`${topic} recorded; no customer-level records are held`, { shop, outcome: recorded.outcome });
    }
  } catch (error) {
    log.error(`${topic} could not be recorded`, { shop });
    captureBackgroundFailure("shopify-compliance", error);
    return Response.json({ error: "Not recorded" }, { status: 500 });
  }

  return Response.json({ received: true }, { status: 200 });
}

/**
 * Deletes as soon as the request is recorded. A failure leaves the deletion
 * open and visible; the deletion job retries it until verified.
 */
export async function runShopRedaction(recorded: RedactResult, shop: string): Promise<void> {
  try {
    if (recorded.deletion_id) {
      const result = await processWorkspaceDeletion(recorded.deletion_id);
      if (result.outcome !== "completed") log.warn("Workspace deletion not finished; it will be retried", { shop });
    } else if (recorded.compliance_request_id) {
      const result = await processUnboundShopRedact(recorded.compliance_request_id);
      if (result.outcome === "failed") log.warn("Shop redaction not finished; it will be retried", { shop });
    }
  } catch (error) {
    log.error("Shop redaction failed; it will be retried", { shop });
    captureBackgroundFailure("shop-redaction", error);
  }
}
