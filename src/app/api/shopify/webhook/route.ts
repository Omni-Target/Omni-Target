import { verifyShopifyHmac } from "@/lib/verify-shopify-hmac";
import { revokeShopAccess, supabaseAdmin } from "@/lib/db";
import { createHash } from "crypto";
import { after } from "next/server";

export const dynamic = "force-dynamic";

/** Subset of the Shopify orders/create webhook payload we read. */
interface ShopifyOrderPayload {
  id?: number | string;
  created_at?: string;
  currency?: string;
  total_price?: string;
  current_total_price?: string;
  customer?: { email?: string; phone?: string };
  billing_address?: { phone?: string };
  shipping_address?: { phone?: string };
  client_details?: { browser_ip?: string; user_agent?: string };
}

function hashSha256(value?: string): string | null {
  if (!value) return null;
  return createHash("sha256")
    .update(value.trim().toLowerCase())
    .digest("hex");
}

/** A webhook only marks a snapshot stale if it is older than this. */
const STALE_MARK_MIN_AGE_MS = 15 * 60_000;

/**
 * Delivery deduplication (ING-05): one row per (shop, webhook id). Returns false
 * only for a repeat delivery. Without a webhook id, or before migration 0015,
 * processing continues and the business-event key below still protects Meta.
 */
async function claimWebhookDelivery(shopDomain: string, webhookId: string | null, topic: string | null): Promise<boolean> {
  if (!webhookId) return true;
  const { data, error } = await supabaseAdmin
    .from("webhook_deliveries")
    .upsert(
      { shop_domain: shopDomain.toLowerCase(), webhook_id: webhookId, topic: topic ?? "unknown" },
      { onConflict: "shop_domain,webhook_id", ignoreDuplicates: true },
    )
    .select("webhook_id");
  if (error) {
    console.error("Webhook delivery claim unavailable:", error.message);
    return true;
  }
  return (data as unknown[]).length > 0;
}

/**
 * Business-event idempotency (ING-05): one row per (shop, order, event type),
 * so a Purchase is sent once however many webhooks mention the order. Returns
 * the claim id, or null if already claimed. Until migration 0015 is applied the
 * new columns do not exist, and a best-effort existence check stands in.
 */
async function claimCapiEvent(row: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("capi_events")
    .upsert(row, { onConflict: "shop_domain,shopify_order_id,event_type", ignoreDuplicates: true })
    .select("id");
  if (!error) return (data as { id: string }[])[0]?.id ?? null;

  if (error.code !== "42P10" && error.code !== "PGRST204" && error.code !== "42703") throw error;
  const legacyRow = { ...row };
  delete legacyRow.shop_domain;
  delete legacyRow.event_type;
  const { data: existing } = await supabaseAdmin
    .from("capi_events")
    .select("id")
    .eq("clerk_user_id", row.clerk_user_id as string)
    .eq("shopify_order_id", row.shopify_order_id as string)
    .limit(1);
  if (existing?.length) return null;
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("capi_events")
    .insert(legacyRow)
    .select("id");
  if (insertError) throw insertError;
  return (inserted as { id: string }[])[0]?.id ?? null;
}

interface WebhookIntegration {
  clerk_user_id: string;
  meta_access_token?: string | null;
  meta_pixel_id?: string | null;
}

async function forwardPurchaseToMeta(shopDomain: string, integration: WebhookIntegration, payload: ShopifyOrderPayload) {
  const { meta_access_token: metaAccessToken, meta_pixel_id: metaPixelId } = integration;
  if (!metaAccessToken || !metaPixelId || payload.id === undefined) return;

  const eventId = String(payload.id);
  const currency = payload.currency || "NGN";
  const totalValue = parseFloat(payload.total_price || payload.current_total_price || "0");

  const claimId = await claimCapiEvent({
    shop_domain: shopDomain.toLowerCase(),
    event_type: "Purchase",
    clerk_user_id: integration.clerk_user_id,
    shopify_order_id: eventId,
    order_value: totalValue,
    currency,
    status: "pending",
  });
  if (!claimId) return; // Redelivered webhook: this order was already sent.

  // Hash customer data for Meta CAPI privacy requirements (SHA-256)
  const phone = payload.customer?.phone || payload.billing_address?.phone || payload.shipping_address?.phone;
  const userData: Record<string, unknown> = {};
  const hashedEmail = hashSha256(payload.customer?.email);
  if (hashedEmail) userData.em = [hashedEmail];
  const hashedPhone = hashSha256(phone);
  if (hashedPhone) userData.ph = [hashedPhone];
  if (payload.client_details?.browser_ip) userData.client_ip_address = payload.client_details.browser_ip;
  if (payload.client_details?.user_agent) userData.client_user_agent = payload.client_details.user_agent;

  const capiPayload: Record<string, unknown> = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(new Date(payload.created_at || Date.now()).getTime() / 1000),
        event_id: eventId,
        user_data: userData,
        custom_data: { currency, value: totalValue },
        action_source: "website",
      },
    ],
  };
  if (process.env.META_CAPI_TEST_CODE) capiPayload.test_event_code = process.env.META_CAPI_TEST_CODE;

  let status = "failed";
  let metaResponse: unknown = null;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${metaPixelId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...capiPayload, access_token: metaAccessToken }),
    });
    metaResponse = await metaRes.json();
    status = metaRes.ok ? "sent" : "failed";
  } catch (err) {
    console.error("Meta CAPI send failed:", err instanceof Error ? err.name : "unknown");
  }

  const { error } = await supabaseAdmin
    .from("capi_events")
    .update({ meta_response: metaResponse, status })
    .eq("id", claimId);
  if (error) console.error("Failed to record CAPI result:", error.message);
}

/** Runs after the response is sent, so Shopify gets its 200 immediately. */
async function processWebhook(shopDomain: string, topic: string | null, payload: ShopifyOrderPayload) {
  if (topic === "app/uninstalled") {
    // SEC-09: the tokens are dead. Stored data waits for shop/redact (48h).
    await revokeShopAccess(shopDomain);
    return;
  }

  // Newest row first: duplicate rows for one shop must not drop the webhook.
  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select("clerk_user_id, meta_access_token, meta_pixel_id")
    .or(`shopify_store_url.eq.${shopDomain},shop_domain.eq.${shopDomain}`)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("Error looking up integration for webhook:", error.message);
    return;
  }
  const integration = (data as WebhookIntegration[] | null)?.[0];
  if (!integration) {
    console.warn(`No integration found matching shop domain: ${shopDomain}`);
    return;
  }

  if (topic === "orders/paid") {
    await forwardPurchaseToMeta(shopDomain, integration, payload);
  }

  // ING-05: the next visit refreshes the store. A full sync per order was
  // unbounded work inside a webhook, and busy stores re-synced constantly.
  const { error: staleError } = await supabaseAdmin
    .from("user_integrations")
    .update({ store_snapshot_at: null })
    .eq("clerk_user_id", integration.clerk_user_id)
    .lt("store_snapshot_at", new Date(Date.now() - STALE_MARK_MIN_AGE_MS).toISOString());
  if (staleError) console.error("Failed to mark snapshot stale:", staleError.message);
}

export async function POST(request: Request) {
  console.log("Shopify webhook received");

  // Read raw body immediately for HMAC verification
  const rawBody = await request.text();
  const hmacHeader = request.headers.get("X-Shopify-Hmac-SHA256") || request.headers.get("x-shopify-hmac-sha256");
  const topicHeader = request.headers.get("X-Shopify-Topic") || request.headers.get("x-shopify-topic");
  const shopDomain = request.headers.get("X-Shopify-Shop-Domain") || request.headers.get("x-shopify-shop-domain");

  if (!hmacHeader) {
    console.error("Missing Shopify HMAC header");
    return new Response("Missing HMAC signature", { status: 401 });
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("SHOPIFY_WEBHOOK_SECRET is not configured");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  // 1. Verify webhook authenticity
  const isValid = await verifyShopifyHmac(rawBody, hmacHeader, secret);
  if (!isValid) {
    console.error("Invalid Shopify HMAC signature");
    return new Response("Invalid signature", { status: 401 });
  }

  if (!shopDomain) {
    console.error("Missing Shopify shop domain header");
    return new Response("Missing shop domain", { status: 400 });
  }

  console.log(`Verified Shopify webhook. Topic: ${topicHeader}, Shop: ${shopDomain}`);

  // 2. Parse payload
  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error("Failed to parse webhook JSON payload:", err);
    return new Response("Invalid JSON", { status: 400 });
  }

  // Repeat delivery of this exact webhook: acknowledge and do nothing.
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  if (!(await claimWebhookDelivery(shopDomain, webhookId, topicHeader))) {
    return Response.json({ received: true, duplicate: true }, { status: 200 });
  }

  // 3. Acknowledge immediately; the work runs after the response is sent.
  after(() =>
    processWebhook(shopDomain, topicHeader, payload).catch((err) =>
      console.error("Webhook processing failed:", err instanceof Error ? err.message : "unknown"),
    ),
  );

  return Response.json({ received: true }, { status: 200 });
}
