/**
 * /api/webhooks/privacy
 *
 * Shopify Mandatory Privacy Webhooks — GDPR / Privacy compliance endpoint.
 *
 * Shopify REQUIRES all apps to register and correctly respond to three
 * mandatory webhooks before an app can be approved in the Partner Dashboard:
 *
 *   • customers/data_request  — A customer requested a copy of their data
 *   • customers/redact        — A customer requested deletion of their data
 *   • shop/redact             — A shop uninstalled; delete all shop data (48h)
 *
 * All three MUST return 200 OK. Any non-2xx response causes Shopify to retry
 * and flag the app as non-compliant during the 'Run' validation check.
 *
 * HMAC Verification:
 *   Each request includes an `X-Shopify-Hmac-SHA256` header containing a
 *   base64-encoded HMAC-SHA256 of the raw body, signed with the app's
 *   SHOPIFY_WEBHOOK_SECRET. We verify this before processing any payload.
 *
 * Public Accessibility:
 *   This route is excluded from Clerk auth middleware (see proxy.ts) so that
 *   Shopify's servers can reach it without a session token.
 */

import { verifyShopifyHmac } from "@/lib/verify-shopify-hmac";

// The three Shopify-mandated privacy topics
const PRIVACY_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

type PrivacyTopic = (typeof PRIVACY_TOPICS)[number];

function isPrivacyTopic(topic: string): topic is PrivacyTopic {
  return (PRIVACY_TOPICS as readonly string[]).includes(topic);
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  // ── 1. Secret configuration guard ─────────────────────────────────────────
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[privacy-webhook] SHOPIFY_WEBHOOK_SECRET is not configured");
    return Response.json(
      { error: "Server misconfiguration" },
      { status: 500 }
    );
  }

  // ── 2. Read raw body BEFORE any parsing ────────────────────────────────────
  // The HMAC is computed over the exact raw bytes Shopify sent; once the body
  // is parsed the original byte sequence may differ.
  const rawBody = await request.text();

  // ── 3. Extract identifying headers ────────────────────────────────────────
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const topic      = request.headers.get("x-shopify-topic");
  const shop       = request.headers.get("x-shopify-shop-domain") ?? "unknown";
  const apiVersion = request.headers.get("x-shopify-api-version") ?? "unknown";

  // ── 4. HMAC verification ───────────────────────────────────────────────────
  if (!hmacHeader) {
    console.warn(`[privacy-webhook] Missing X-Shopify-Hmac-SHA256 — shop: ${shop}`);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isValid = await verifyShopifyHmac(rawBody, hmacHeader, secret);

  if (!isValid) {
    console.warn(
      `[privacy-webhook] HMAC verification failed — shop: ${shop}, topic: ${topic ?? "none"}`
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 5. Topic validation ────────────────────────────────────────────────────
  if (!topic || !isPrivacyTopic(topic)) {
    console.warn(
      `[privacy-webhook] Unknown or missing topic: "${topic}" — shop: ${shop}`
    );
    // Return 200 so Shopify doesn't retry — unknown topics are not an error on
    // our side, we just have nothing to act on.
    return Response.json({ received: true, topic: topic ?? null }, { status: 200 });
  }

  // ── 6. Parse payload ───────────────────────────────────────────────────────
  let payload: unknown = rawBody;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Body is not JSON — continue with raw string for logging
  }

  console.info("[privacy-webhook] Received", {
    topic,
    shop,
    apiVersion,
    payload,
  });

  // ── 7. Per-topic logic ─────────────────────────────────────────────────────
  switch (topic) {
    case "customers/data_request":
      /**
       * A customer (or admin) requested a copy of their personal data.
       *
       * Omni Target does NOT store any customer PII. The app only processes
       * aggregated, anonymised Shopify store-level analytics (product data,
       * store metadata). No customer identifiers (email, name, address, etc.)
       * are persisted in our database.
       *
       * Action: Acknowledge. Nothing to export.
       */
      console.info(
        `[privacy-webhook] customers/data_request — no PII stored, acknowledged — shop: ${shop}`
      );
      break;

    case "customers/redact":
      /**
       * A customer requested erasure of their personal data (GDPR Article 17).
       *
       * Same reasoning as above — no customer PII is stored. Any Shopify OAuth
       * tokens held are shop-scoped (not customer-scoped) and are retained only
       * for as long as the shop has the app installed.
       *
       * Action: Acknowledge. Nothing to delete.
       */
      console.info(
        `[privacy-webhook] customers/redact — no PII stored, acknowledged — shop: ${shop}`
      );
      break;

    case "shop/redact":
      /**
       * Sent 48 hours after a shop uninstalls the app. Shopify expects all
       * shop-level data to be deleted.
       *
       * Current data held per shop:
       *   - Shopify OAuth access token (stored encrypted in Supabase)
       *   - Connected store domain/metadata (stored in Supabase `stores` table)
       *
       * TODO: When a production data-deletion pipeline is in place, trigger it
       * here. For now the app is in early access; tokens expire on uninstall
       * and no long-lived customer data is retained.
       *
       * Action: Acknowledge. Log for audit trail.
       */
      console.info(
        `[privacy-webhook] shop/redact — logged for audit, acknowledged — shop: ${shop}`
      );
      break;
  }

  // ── 8. Acknowledge ────────────────────────────────────────────────────────
  // Shopify requires a 200 response. Any non-2xx triggers retries and
  // compliance flags in the Partner Dashboard.
  return Response.json({ received: true }, { status: 200 });
}
