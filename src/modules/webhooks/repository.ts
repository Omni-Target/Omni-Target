import "server-only";
import { supabaseAdmin } from "@/platform/supabase";

/**
 * Delivery deduplication (ING-05): one row per (shop, webhook id). Returns false
 * only for a repeat delivery. Without a webhook id, or when the table cannot be
 * reached, processing continues and the business-event key still protects Meta.
 */
export async function claimWebhookDelivery(shopDomain: string, webhookId: string | null, topic: string | null): Promise<boolean> {
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
