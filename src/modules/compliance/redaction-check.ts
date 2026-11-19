import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import { asBytea, subjectDigest, suppressionKey, type SubjectType } from "./suppression";

/**
 * Whether a customer or order named in a webhook was redacted (decision 5),
 * for write paths outside the ingestion RPCs, which check digests themselves.
 * The Meta conversions path asks before it stores or sends anything about an
 * order. Throws when the answer cannot be known; callers then send nothing.
 */
export async function redactedSubject(shopDomain: string, subjects: { orderId?: number | null; customerId?: number | null }): Promise<boolean> {
  const { data: shop, error } = await supabaseAdmin.from("shops").select("shopify_shop_id").eq("myshopify_domain", shopDomain.toLowerCase()).maybeSingle();
  if (error) throw new Error(`shops read failed: ${error.message}`);
  if (!shop?.shopify_shop_id) return false; // A shop never modelled has no suppressions recorded under its ID.
  const shopifyShopId = Number(shop.shopify_shop_id);
  const key = suppressionKey();
  const checks: Array<[SubjectType, number]> = [];
  if (subjects.orderId) checks.push(["order", subjects.orderId]);
  if (subjects.customerId) checks.push(["customer", subjects.customerId]);
  for (const [type, id] of checks) {
    const { data, error: rpcError } = await supabaseAdmin.rpc("suppressed_subjects", {
      p_shopify_shop_id: shopifyShopId, p_subject_type: type, p_digests: [asBytea(subjectDigest(key, shopifyShopId, type, id))],
    });
    if (rpcError) throw new Error(`suppressed_subjects failed: ${rpcError.message}`);
    if (Array.isArray(data) && data.length > 0) return true;
  }
  return false;
}
