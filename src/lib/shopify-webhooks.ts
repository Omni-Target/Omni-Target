import { verifyShopifyHmac } from "@/lib/verify-shopify-hmac";
import { redactShopData } from "@/lib/db";
import { createLogger } from "@/lib/logger";

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
 * verification and the redaction logic live in exactly one place.
 *
 *   • customers/data_request — customer requested their data
 *   • customers/redact       — customer requested deletion
 *   • shop/redact            — shop uninstalled; delete shop data (sent 48h later)
 *
 * All paths return 200 once authenticated — Shopify retries and flags the app
 * as non-compliant on any non-2xx. Both routes are excluded from Clerk auth in
 * proxy.ts so Shopify's servers (no session) can reach them; authenticity is
 * verified here via the HMAC signature.
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
  const shop = request.headers.get("x-shopify-shop-domain") ?? "unknown";

  if (!hmacHeader) {
    log.warn("Missing X-Shopify-Hmac-SHA256 header", { shop });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await verifyShopifyHmac(rawBody, hmacHeader, secret))) {
    log.warn("HMAC verification failed", { shop, topic });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Unknown/missing topic: acknowledge with 200 so Shopify doesn't retry —
  // there's simply nothing for us to act on.
  if (!isPrivacyTopic(topic)) {
    log.warn("Unknown or missing topic", { topic, shop });
    return Response.json({ received: true, topic: topic ?? null }, { status: 200 });
  }

  if (topic === "shop/redact") {
    // 48h after uninstall: clear the Shopify-scoped tokens + cached store
    // snapshot for this shop (best-effort; redactShopData never throws so we
    // can still return the required 200). The customer topics need no action —
    // no customer PII is persisted.
    const redacted = await redactShopData(shop);
    log.info(
      `shop/redact redaction ${redacted ? "completed" : "no-op/failed"}`,
      { shop },
    );
  } else {
    log.info(`${topic} acknowledged (no customer PII stored)`, { shop });
  }

  return Response.json({ received: true }, { status: 200 });
}
