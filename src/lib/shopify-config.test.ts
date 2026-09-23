import { describe, expect, it } from "vitest";
import {
  SHOPIFY_API_VERSION,
  SHOPIFY_REQUIRED_SCOPES,
  SHOPIFY_SCOPE_PARAM,
  getMissingShopifyScopes,
  parseShopifyScopes,
  shopifyAdminGraphqlUrl,
} from "./shopify-config";

describe("Shopify configuration", () => {
  it("keeps the legacy OAuth scope parameter complete and deduplicated", () => {
    expect(SHOPIFY_SCOPE_PARAM.split(",")).toEqual([...SHOPIFY_REQUIRED_SCOPES]);
    expect(new Set(SHOPIFY_REQUIRED_SCOPES).size).toBe(SHOPIFY_REQUIRED_SCOPES.length);
  });

  it("normalizes granted scopes and reports only missing permissions", () => {
    expect(parseShopifyScopes("read_products, read_orders,read_products")).toEqual([
      "read_orders",
      "read_products",
    ]);
    expect(parseShopifyScopes("read_products read_orders")).toEqual([
      "read_orders",
      "read_products",
    ]);
    const missing = getMissingShopifyScopes([
      ...SHOPIFY_REQUIRED_SCOPES.filter((scope) => scope !== "read_reports"),
    ]);
    expect(missing).toEqual(["read_reports"]);
  });

  it("uses the configured API version for GraphQL", () => {
    expect(SHOPIFY_API_VERSION).toBe("2026-07");
    expect(shopifyAdminGraphqlUrl("store.myshopify.com")).toBe(
      "https://store.myshopify.com/admin/api/2026-07/graphql.json",
    );
  });
});
