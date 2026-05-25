import { verifyShopifyHmac } from "@/lib/verify-shopify-hmac";

const GDPR_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

type GdprTopic = (typeof GDPR_TOPICS)[number];

function isValidTopic(topic: string): topic is GdprTopic {
  return (GDPR_TOPICS as readonly string[]).includes(topic);
}

export async function POST(request: Request) {
  // Shopify signs webhook payloads with SHOPIFY_WEBHOOK_SECRET
  // (same value as CLIENT_SECRET in this app, but use the dedicated
  // webhook secret var for clarity and forward-compatibility).
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[GDPR] SHOPIFY_WEBHOOK_SECRET is not configured");
    return Response.json(
      { error: "Server misconfiguration" },
      { status: 500 }
    );
  }

  // Read the raw body once — needed for HMAC verification
  const rawBody = await request.text();

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic");
  const shop = request.headers.get("x-shopify-shop-domain") ?? "unknown";

  // --- HMAC verification ---
  if (!hmacHeader) {
    console.warn(`[GDPR] Missing HMAC header — shop: ${shop}`);
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const isValid = await verifyShopifyHmac(rawBody, hmacHeader, secret);
  if (!isValid) {
    console.warn(
      `[GDPR] HMAC verification failed — shop: ${shop}, topic: ${topic ?? "none"}`
    );
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  // --- Topic validation ---
  if (!topic || !isValidTopic(topic)) {
    console.warn(`[GDPR] Unknown or missing topic: "${topic}" — shop: ${shop}`);
    return Response.json(
      { error: "Unrecognized topic" },
      { status: 422 }
    );
  }

  // --- Parse and log payload ---
  let payload: unknown = rawBody;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Payload is not JSON — log as-is
  }

  console.info(`[GDPR] Received webhook`, {
    topic,
    shop,
    payload,
  });

  // --- Per-topic acknowledgement ---
  switch (topic) {
    case "customers/data_request":
      // Shopify customer requests a copy of their data.
      // No personal data is stored beyond what Shopify manages; nothing to retrieve.
      console.info(`[GDPR] customers/data_request acknowledged — shop: ${shop}`);
      break;

    case "customers/redact":
      // Shopify requests deletion of a customer's personal data.
      // No personal data is persisted by this app; nothing to delete.
      console.info(`[GDPR] customers/redact acknowledged — shop: ${shop}`);
      break;

    case "shop/redact":
      // Shopify requests deletion of all data for a shop (48h after uninstall).
      // No shop-level personal data is persisted by this app; nothing to delete.
      console.info(`[GDPR] shop/redact acknowledged — shop: ${shop}`);
      break;
  }

  return Response.json({ received: true }, { status: 200 });
}
