import "server-only";
import { supabaseAdmin } from "@/platform/supabase";

/**
 * Business-event idempotency (ING-05): one row per (shop, order, event type),
 * so a Purchase is sent once however many webhooks mention the order. Returns
 * the claim id, or null if already claimed. Before migration 0015 the new
 * columns do not exist, and a best-effort existence check stands in.
 */
export async function claimCapiEvent(row: Record<string, unknown>): Promise<string | null> {
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

/** Records Meta's answer on the claimed event. */
export async function recordCapiResult(claimId: string, metaResponse: unknown, status: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("capi_events")
    .update({ meta_response: metaResponse, status })
    .eq("id", claimId);
  if (error) console.error("Failed to record CAPI result:", error.message);
}
