import type { StoreData } from "@/lib/store-data";

/**
 * Shape of a `user_integrations` row as the app consumes it.
 *
 * The table is shared across providers (Shopify + Meta) and has drifted over
 * time, and several call sites use dynamic column selects — so this is a
 * permissive view: every known column is typed, and an index signature allows
 * dynamically-selected columns without resorting to `any`. Provider arrays
 * (`meta_ad_accounts`, `meta_pages`) stay `unknown`; narrow them at the point of
 * use (callers already guard with `Array.isArray`).
 */
export interface UserIntegration {
  clerk_user_id?: string;

  // Credits / billing
  credits?: number | null;
  credits_balance?: number | null;
  credits_total_purchased?: number | null;
  credits_unlimited_until?: string | null;
  free_credit_used?: boolean | null;

  // Meta / Facebook
  meta_access_token?: string | null;
  meta_ad_account_id?: string | null;
  meta_selected_account_id?: string | null;
  meta_page_id?: string | null;
  meta_page_name?: string | null;
  meta_pixel_id?: string | null;
  meta_ad_accounts?: unknown;
  meta_pages?: unknown;

  // Shopify
  shop_domain?: string | null;
  shopify_store_url?: string | null;
  shopify_custom_domain?: string | null;
  shopify_access_token?: string | null;
  shopify_refresh_token?: string | null;
  shopify_token_expires_at?: string | null;
  shopify_scopes?: string[] | string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;

  // Cached store analytics snapshot.
  store_snapshot?: StoreData | null;
  store_snapshot_at?: string | null;

  created_at?: string | null;

  // Allow dynamically-selected / drifted columns without `any`.
  [key: string]: unknown;
}
