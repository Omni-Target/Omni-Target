import type { StoreInsights } from "@/components/campaigns/types";
import type { BriefPDFParams } from "@/lib/generate-brief-pdf";

export interface GenerationContext {
  gatewayInsight: BriefPDFParams["gatewayInsight"] | null;
  storeDataForApi: { orderVolumeTier: string } | null;
  storePrices: number[];
}

/**
 * Derives the store-driven inputs for a campaign generation request: the
 * gateway/bestseller insight, the coarse order-volume tier, and the list of
 * positive store prices.
 *
 * Pure: the caller owns the `setGatewayInsight` side effect. `gatewayInsight`
 * and `storeDataForApi` are non-null exactly when the store has a `products`
 * array (mirroring the original inline `if (storeInsights?.products)` guard).
 */
export function buildGenerationContext(
  storeInsights: StoreInsights | null,
  productName: string,
): GenerationContext {
  let gatewayInsight: BriefPDFParams["gatewayInsight"] | null = null;
  let storeDataForApi: { orderVolumeTier: string } | null = null;

  if (storeInsights?.products) {
    const products = storeInsights.products;
    const bestseller = [...products].sort(
      (a, b) => (b.revenue ?? 0) - (a.revenue ?? 0),
    )[0];
    const gatewayProducts = products.filter(
      (p) => p.gateway_classification === "Gateway",
    );
    const topGateway =
      gatewayProducts.length > 0
        ? [...gatewayProducts].sort(
            (a, b) => (b.revenue ?? 0) - (a.revenue ?? 0),
          )[0]
        : null;

    const normalizeStr = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normalizedInput = normalizeStr(productName);
    const currentProduct = products.find(
      (p) => normalizeStr(p.name ?? "") === normalizedInput,
    );

    gatewayInsight = {
      currentProductClassification:
        currentProduct?.gateway_classification || "Unknown",
      currentProductName: currentProduct?.name,
      currentProductImage: currentProduct?.image_url,
      bestsellerName: bestseller?.name,
      topGatewayName: topGateway?.name,
      isBestsellerGateway: bestseller?.id === topGateway?.id,
      currentProductVelocity: currentProduct?.order_velocity,
      currentProductRepeatRate: currentProduct?.repeat_purchase_rate,
      storeAov: storeInsights.orders?.average_order_value,
      storeBaseFtb:
        products.reduce((acc, p) => acc + (p.first_time_buyer_ratio || 0), 0) /
        products.length,
    } as BriefPDFParams["gatewayInsight"];

    storeDataForApi = {
      orderVolumeTier:
        (storeInsights.orders?.orders_last_30_days ?? 0) > 200
          ? "High"
          : (storeInsights.orders?.orders_last_30_days ?? 0) > 50
            ? "Medium"
            : "Low",
    };
  }

  const storePrices: number[] = (storeInsights?.products ?? [])
    .map((p) => Number(p.price))
    .filter((p) => p > 0);

  return { gatewayInsight, storeDataForApi, storePrices };
}
