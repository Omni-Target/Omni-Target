import { verifyShopifyHmac } from "@/lib/verify-shopify-hmac";
import { supabaseAdmin, updateUserIntegration } from "@/lib/db";
import { fetchShopifyStoreData } from "@/lib/connectors/shopify";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";

function hashSha256(value?: string): string | null {
  if (!value) return null;
  return createHash("sha256")
    .update(value.trim().toLowerCase())
    .digest("hex");
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
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error("Failed to parse webhook JSON payload:", err);
    return new Response("Invalid JSON", { status: 400 });
  }

  // 3. Send 200 OK immediately before any heavy processing
  const response = Response.json({ received: true }, { status: 200 });

  // 4. Run heavy processing asynchronously in the background
  (async () => {
    try {
      // Find the user integration matching this Shopify store
      const { data: integration, error: dbError } = await supabaseAdmin
        .from("user_integrations")
        .select("*")
        .or(`shopify_store_url.eq.${shopDomain},shop_domain.eq.${shopDomain}`)
        .maybeSingle();

      if (dbError) {
        console.error("Error looking up integration for webhook:", dbError);
        return;
      }

      if (!integration) {
        console.warn(`No integration found matching shop domain: ${shopDomain}`);
        return;
      }

      console.log(`Processing background job for user: ${integration.clerk_user_id}`);

      // Handle specific webhook topics
      if (topicHeader === "orders/paid") {
        console.log(`Processing orders/paid for order ID: ${payload.id}`);

        // Forward to Meta Conversions API (CAPI) if credentials exist
        const metaAccessToken = integration.meta_access_token;
        const metaPixelId = integration.meta_pixel_id;

        if (metaAccessToken && metaPixelId) {
          try {
            const eventId = String(payload.id);
            const eventTime = Math.floor(new Date(payload.created_at || Date.now()).getTime() / 1000);

            // Hash customer data for Meta CAPI privacy requirements (SHA-256)
            const email = payload.customer?.email;
            const phone = payload.customer?.phone || payload.billing_address?.phone || payload.shipping_address?.phone;

            const userData: Record<string, any> = {};
            
            const hashedEmail = hashSha256(email);
            if (hashedEmail) {
              userData.em = [hashedEmail];
            }

            const hashedPhone = hashSha256(phone);
            if (hashedPhone) {
              userData.ph = [hashedPhone];
            }

            if (payload.client_details?.browser_ip) {
              userData.client_ip_address = payload.client_details.browser_ip;
            }
            if (payload.client_details?.user_agent) {
              userData.client_user_agent = payload.client_details.user_agent;
            }

            const currency = payload.currency || "NGN";
            const totalValue = parseFloat(payload.total_price || payload.current_total_price || "0");

            const capiPayload: Record<string, any> = {
              data: [
                {
                  event_name: "Purchase",
                  event_time: eventTime,
                  event_id: eventId,
                  user_data: userData,
                  custom_data: {
                    currency: currency,
                    value: totalValue,
                  },
                  action_source: "website",
                },
              ],
            };

            // Route test events if test code is configured
            if (process.env.META_CAPI_TEST_CODE) {
              capiPayload.test_event_code = process.env.META_CAPI_TEST_CODE;
            }

            console.log(`Sending Meta CAPI Purchase event for order ${eventId} to Pixel ${metaPixelId}`);

            const metaRes = await fetch(
              `https://graph.facebook.com/v19.0/${metaPixelId}/events`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ...capiPayload,
                  access_token: metaAccessToken,
                }),
              }
            );

            const metaResult = await metaRes.json();
            console.log("Meta CAPI API response:", metaResult);

            // Log event to Supabase capi_events table
            const { error: capiInsertErr } = await supabaseAdmin
              .from("capi_events")
              .insert({
                clerk_user_id: integration.clerk_user_id,
                shopify_order_id: eventId,
                order_value: totalValue,
                currency: currency,
                meta_response: metaResult,
                status: metaRes.ok ? "sent" : "failed",
              });

            if (capiInsertErr) {
              console.error("Failed to insert CAPI event log:", capiInsertErr);
            } else {
              console.log("Saved CAPI event log successfully");
            }
          } catch (capiErr) {
            console.error("Meta CAPI processing failed:", capiErr);
          }
        } else {
          console.log("Skipping Meta CAPI: Missing Meta pixel ID or access token");
        }
      }

      // 5. Trigger database sync of Shopify store data to update dashboard
      try {
        const accessToken = integration.shopify_access_token || integration.access_token;
        if (accessToken) {
          console.log(`Starting background Shopify store sync for ${shopDomain}`);
          const storeData = await fetchShopifyStoreData(shopDomain, accessToken);

          await updateUserIntegration(integration.clerk_user_id, {
            store_snapshot: storeData,
            store_snapshot_at: new Date().toISOString(),
          });
          console.log(`Background Shopify store sync complete for ${shopDomain}`);
        }
      } catch (syncErr) {
        console.error("Background Shopify store sync failed:", syncErr);
      }

    } catch (backgroundErr) {
      console.error("Background webhook execution error:", backgroundErr);
    }
  })();

  return response;
}
