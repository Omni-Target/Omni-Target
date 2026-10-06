import type { StoreData } from "./store-data";
import type { TargetingProfile } from "./insights-engine";
import { isFallbackCountryEntry } from "./market-geography";
import { assessShopifyMarketReadiness } from "./shopify-readiness";

/** AI may propose cities, but cannot certify its own evidence or historical timing. */
export function groundTargetingProfile(profile: TargetingProfile, store: StoreData): TargetingProfile {
  const key = (name: string) => name.trim().toLowerCase();
  // Legacy snapshots could contain country-to-city guesses; re-sync before certifying them.
  const verified = (store.data_quality?.schema_version || 0) >= 2;
  const observed = new Map(store.orders.top_locations.filter((l) => !isFallbackCountryEntry(l)).map((l) => [key(l.city), l]));
  return {
    ...profile,
    locations: profile.locations.map((location) => {
      const match = observed.get(key(location.name));
      const fromData = verified && match && match.source !== "recommended";
      const readiness = assessShopifyMarketReadiness(
        store.prespend,
        (fromData ? match.country : location.country) || "",
      );
      const readinessNote = readiness.status === "ready"
        ? `Shopify readiness verified: ${readiness.evidence.join(" ")}`
        : readiness.status === "blocked"
          ? `Demand hypothesis only; Shopify configuration is not launch-ready: ${readiness.evidence.join(" ")}`
          : `Demand hypothesis; fulfillment remains unverified: ${readiness.evidence.join(" ")}`;
      return {
        ...location,
        source: fromData ? "from_data" : "recommended",
        percentage: fromData ? match.percentage : null,
        country: fromData ? match.country : location.country,
        note: [location.note, readinessNote].filter(Boolean).join(" "),
      };
    }),
    timing: {
      peak_days: store.orders.peak_days,
      launch_recommendation: store.orders.peak_days.length
        ? `Consider launching at the start of ${store.orders.peak_days[0]} in your ad account timezone.`
        : "No historical peak day is available. Launch when your store and creative are ready.",
      reasoning: "Historical order days describe past purchases, not predicted ad performance. Keep a consistent test schedule.",
    },
  };
}
