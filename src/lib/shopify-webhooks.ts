import { after } from "next/server";
import { verifyShopifyHmac } from "@/lib/verify-shopify-hmac";
import { createLogger } from "@/lib/logger";
import { captureBackgroundFailure } from "@/lib/observability/capture";
import { lifecycleEventKey, parseShopifyShopId, parseTriggeredAt, webhookShopDomain } from "@/modules/workspaces/lifecycle";
import { shopKeyFor } from "@/modules/ingestion/repository";
import { purgeShopStaging, r2StagingStore } from "@/modules/ingestion/staging";
import { settleClosedExports } from "@/modules/compliance/data-requests";
import { liveDataRequestDeps } from "@/modules/compliance/live";
import { dispatchComplianceExport } from "@/modules/jobs/trigger";
import {
  processUnboundShopRedact,
  processWorkspaceDeletion,
  recordCustomerCompliance,
  recordShopRedact,
  type ComplianceSubject,
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
 *   • customers/redact: recorded, and the customer's data in the commerce
 *     mirror (customer row, the identifying fields on their orders, inbox
 *     payloads naming them) is removed in the same transaction (0030).
 *   • customers/data_request: recorded; resolved at once when no data is
 *     held. Otherwise an export is opened and dispatched to Trigger.dev, which
 *     prepares the customer's data, delivers it to the workspace owner in the
 *     app and completes the request; hourly maintenance retries and escalates
 *     before the 30-day deadline (task 9, migration 0037).
 *   • customers/redact also withdraws any export of the customer's data and
 *     deletes its file, and removes the Meta send logs for their orders.
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
      after(async () => {
        await runShopRedaction(recorded, shop);
        // Exports of the shop's customers go with the shop's data (decision 5).
        await settleExportsFor(shop);
      });
    } else {
      const recorded = await recordCustomerCompliance(topic, event, complianceSubject(topic, payload));
      log.info(`${topic} recorded`, { shop, outcome: recorded.outcome, resolution: recorded.resolution ?? null });
      const requestId = recorded.compliance_request_id;
      if (topic === "customers/data_request" && recorded.outcome === "open" && requestId) {
        // The customer's data is held: export it for the merchant (maintenance retries a failed dispatch).
        after(() => dispatchComplianceExport(requestId, "webhook"));
      }
      if (topic === "customers/redact") {
        // Temporary bulk files may hold the redacted customer: purge the shop's staging (decision 5).
        after(() => purgeStagingFor(shop));
        if ((recorded.redacted?.exports_withdrawn ?? 0) > 0) after(() => settleExportsFor(shop));
      }
    }
  } catch (error) {
    log.error(`${topic} could not be recorded`, { shop });
    captureBackgroundFailure("shopify-compliance", error);
    return Response.json({ error: "Not recorded" }, { status: 500 });
  }

  return Response.json({ received: true }, { status: 200 });
}

/**
 * The customer and orders a customers/* payload names. Shopify sends
 * customer.id with orders_to_redact (redact) or orders_requested
 * (data_request); IDs parse like the shop's, and anything else is ignored.
 */
export function complianceSubject(topic: "customers/redact" | "customers/data_request", payload: unknown): ComplianceSubject {
  const body = (payload ?? {}) as { customer?: { id?: unknown } | null; orders_to_redact?: unknown; orders_requested?: unknown };
  const named = topic === "customers/redact" ? body.orders_to_redact : body.orders_requested;
  return {
    customerId: parseShopifyShopId(body.customer?.id),
    orderIds: Array.isArray(named) ? named.map(parseShopifyShopId).filter((id): id is number => id !== null) : [],
  };
}

/** Withdraws and deletes the shop's closed customer data exports; never raises (hourly maintenance is the backstop). */
export async function settleExportsFor(shop: string): Promise<void> {
  try {
    const report = await settleClosedExports(shop, liveDataRequestDeps());
    if (report.withdrawn || report.filesDeleted) log.info("Customer data exports settled", { shop, withdrawn: report.withdrawn, filesDeleted: report.filesDeleted });
  } catch (error) {
    captureBackgroundFailure("compliance-export-settle", error);
  }
}

/** Deletes the shop's staged bulk results; failures are reported, never raised (the sweep is the backstop). */
export async function purgeStagingFor(shop: string): Promise<void> {
  try {
    const shopKey = await shopKeyFor(shop);
    if (shopKey !== null) await purgeShopStaging(r2StagingStore(), shopKey);
  } catch (error) {
    captureBackgroundFailure("staging-purge", error);
  }
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
