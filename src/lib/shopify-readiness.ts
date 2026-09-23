import type { StorePrespendIntelligence } from "./store-data";
import { normalizeCountry } from "./market-geography";

export type MarketReadinessStatus = "ready" | "blocked" | "unknown";

export interface MarketReadinessAssessment {
  status: MarketReadinessStatus;
  market_active: boolean | null;
  shipping_available: boolean | null;
  fulfillment_available: boolean | null;
  evidence: string[];
}

function sameCountry(value: string, candidate: string): boolean {
  return normalizeCountry(value) === normalizeCountry(candidate);
}

/**
 * Evaluates whether Shopify configuration supports selling into a country.
 * This is an operational readiness check, not a prediction that ads will work.
 */
export function assessShopifyMarketReadiness(
  prespend: StorePrespendIntelligence | undefined,
  country: string,
): MarketReadinessAssessment {
  if (!prespend || !country.trim()) {
    return {
      status: "unknown",
      market_active: null,
      shipping_available: null,
      fulfillment_available: null,
      evidence: ["Shopify market and shipping evidence is unavailable."],
    };
  }

  const marketsAvailable = prespend.capabilities.markets?.status === "available";
  const shippingAvailable = prespend.capabilities.shipping?.status === "available";
  const locationsAvailable = prespend.capabilities.locations?.status === "available";

  const matchingMarket = prespend.markets.find((market) =>
    market.countries.some((candidate) => sameCountry(country, candidate)),
  );
  const marketActive = marketsAvailable
    ? Boolean(matchingMarket && matchingMarket.status.toUpperCase() === "ACTIVE")
    : null;

  const matchingZone = prespend.shipping_zones.find(
    (zone) =>
      zone.active_methods > 0 &&
      zone.countries.some(
        (candidate) =>
          candidate === "REST_OF_WORLD" || sameCountry(country, candidate),
      ),
  );
  const hasShipping = shippingAvailable ? Boolean(matchingZone) : null;
  const hasFulfillment = locationsAvailable
    ? prespend.fulfillment_locations.some(
        (location) =>
          location.fulfills_online_orders && location.has_active_inventory,
      )
    : null;

  const knownChecks = [marketActive, hasShipping, hasFulfillment].filter(
    (value): value is boolean => value !== null,
  );
  const status: MarketReadinessStatus =
    knownChecks.length < 2
      ? "unknown"
      : knownChecks.every(Boolean)
        ? "ready"
        : "blocked";

  const evidence: string[] = [];
  evidence.push(
    marketActive === null
      ? "Shopify Markets could not be checked."
      : marketActive
        ? `${matchingMarket?.name || country} is active in Shopify Markets.`
        : `${country} is not in an active Shopify Market.`,
  );
  evidence.push(
    hasShipping === null
      ? "Shipping zones could not be checked."
      : hasShipping
        ? `${matchingZone?.zone_name || country} has an active Shopify shipping method.`
        : `${country} has no active Shopify shipping method.`,
  );
  evidence.push(
    hasFulfillment === null
      ? "Fulfillment locations could not be checked."
      : hasFulfillment
        ? "At least one online-fulfillment location has active inventory."
        : "No online-fulfillment location with active inventory was found.",
  );

  return {
    status,
    market_active: marketActive,
    shipping_available: hasShipping,
    fulfillment_available: hasFulfillment,
    evidence,
  };
}

export function summarizeShopifyReadiness(
  prespend: StorePrespendIntelligence | undefined,
): string {
  if (!prespend) return "Shopify operational-readiness data is unavailable.";
  const activeMarkets = prespend.markets
    .filter((market) => market.status.toUpperCase() === "ACTIVE")
    .flatMap((market) => market.countries);
  const shippingCountries = prespend.shipping_zones
    .filter((zone) => zone.active_methods > 0)
    .flatMap((zone) => zone.countries);
  const fulfillmentCount = prespend.fulfillment_locations.filter(
    (location) =>
      location.fulfills_online_orders && location.has_active_inventory,
  ).length;

  return [
    `Active Shopify market countries: ${activeMarkets.length ? [...new Set(activeMarkets)].join(", ") : "none verified"}`,
    `Countries with an active shipping method: ${shippingCountries.length ? [...new Set(shippingCountries)].join(", ") : "none verified"}`,
    `Online fulfillment locations with active inventory: ${fulfillmentCount}`,
  ].join("\n");
}
