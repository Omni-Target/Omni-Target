export const SHOPIFY_API_VERSION = "2026-07" as const;

/**
 * Scopes required by Omni Target's Shopify-first pre-spend intelligence.
 *
 * Legacy OAuth is still in use, so this list is the authorization source of
 * truth. Keep shopify.app.toml aligned until the app migrates to Shopify's
 * managed installation flow.
 */
export const SHOPIFY_REQUIRED_SCOPES = [
  "read_all_orders",
  "read_analytics",
  "read_customers",
  "read_discounts",
  "read_inventory",
  "read_legal_policies",
  "read_locales",
  "read_locations",
  "read_marketing_integrated_campaigns",
  "read_marketing_events",
  "read_markets",
  "read_metaobject_definitions",
  "read_metaobjects",
  "read_orders",
  "read_product_listings",
  "read_products",
  "read_publications",
  "read_reports",
  "read_returns",
  "read_shipping",
] as const;

export type ShopifyRequiredScope = (typeof SHOPIFY_REQUIRED_SCOPES)[number];

export const SHOPIFY_SCOPE_PARAM = SHOPIFY_REQUIRED_SCOPES.join(",");

export function parseShopifyScopes(
  scopes: string | string[] | null | undefined
): string[] {
  const values = Array.isArray(scopes) ? scopes : (scopes || "").split(/[,\s]+/);
  return [...new Set(values.map((scope) => scope.trim()).filter(Boolean))].sort();
}

export function getMissingShopifyScopes(
  granted: string | string[] | null | undefined
): ShopifyRequiredScope[] {
  const grantedSet = new Set(parseShopifyScopes(granted));
  return SHOPIFY_REQUIRED_SCOPES.filter((scope) => !grantedSet.has(scope));
}

export function shopifyAdminRestUrl(shop: string, endpoint: string): string {
  return `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`;
}

export function shopifyAdminGraphqlUrl(shop: string): string {
  return shopifyAdminRestUrl(shop, "graphql.json");
}
