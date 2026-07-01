import type { StoreInsights } from "@/components/campaigns/types";

/**
 * Resolves the merchant's bare store hostname (no scheme, no leading `www.`)
 * for use in ad previews — preferring the connected store's domain over the
 * Clerk metadata URL, with a neutral placeholder as the final fallback.
 */
export function resolveStoreDomain(
  storeInsights: StoreInsights | null,
  storeUrl: string,
): string {
  return storeInsights?.store?.domain
    ? new URL(
        storeInsights.store.domain.startsWith("http")
          ? storeInsights.store.domain
          : `https://${storeInsights.store.domain}`,
      ).hostname.replace("www.", "")
    : storeUrl
      ? new URL(
          storeUrl.startsWith("http") ? storeUrl : `https://${storeUrl}`,
        ).hostname.replace("www.", "")
      : "yourstore.com";
}

/** Returns human-readable validation errors for the required brief fields. */
export function validateCampaignForm(input: {
  brandName: string;
  productName: string;
  description: string;
}): string[] {
  const errors: string[] = [];
  if (!input.brandName.trim()) errors.push("Brand name is required");
  if (!input.productName.trim()) errors.push("Product name is required");
  if (!input.description.trim()) errors.push("Product description is required");
  return errors;
}
