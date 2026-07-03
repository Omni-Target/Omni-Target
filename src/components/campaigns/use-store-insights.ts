import { useEffect, useRef, useState } from "react";
import { useStoreData } from "@/hooks/useStoreData";
import type { AiInsights, StoreInsights } from "@/components/campaigns/types";

export interface UseStoreInsightsParams {
  /** Invoked when the Shopify session is dead and the user must be redirected. */
  onReauthRequired: () => void;
  /** Invoked once with the store name when store data loads, to prefill the brand. */
  onStoreName: (name: string) => void;
}

export interface UseStoreInsightsResult {
  storeInsights: StoreInsights | null;
  aiInsights: AiInsights | null;
  loadingAiInsights: boolean;
}

/**
 * Loads the connected store's data and — only if connected — its AI insights.
 *
 * The store snapshot now comes from the shared `["store-data"]` query, so this
 * dedupes with the dashboard/products pages instead of issuing its own
 * `/api/store/data` fetch on every mount. The insights fetch is still a
 * WATERFALL (it starts only once the store resolves as `connected`), preserved
 * from the original. The cross-domain effects — redirect on a dead session,
 * one-time brand-name prefill — are surfaced via the callbacks. Callers MUST
 * pass stable callbacks.
 */
export function useStoreInsights({
  onReauthRequired,
  onStoreName,
}: UseStoreInsightsParams): UseStoreInsightsResult {
  const { data: storeResponse } = useStoreData();
  const [aiInsights, setAiInsights] = useState<AiInsights | null>(null);
  const [loadingAiInsights, setLoadingAiInsights] = useState(false);
  const namedRef = useRef(false);

  const connected = !!(storeResponse?.connected && storeResponse.data);
  const storeInsights: StoreInsights | null = connected
    ? (storeResponse!.data as unknown as StoreInsights)
    : null;

  // React to the shared snapshot landing: redirect on a dead session, or
  // prefill the brand name exactly once (so a later cache refetch can't clobber
  // a name the user has since edited).
  useEffect(() => {
    if (!storeResponse) return;
    if (storeResponse.reauthRequired) {
      onReauthRequired();
      return;
    }
    if (storeResponse.connected && storeResponse.data && !namedRef.current) {
      const name = (storeResponse.data as { store?: { name?: string } }).store
        ?.name;
      if (name) {
        onStoreName(name);
        namedRef.current = true;
      }
    }
  }, [storeResponse, onReauthRequired, onStoreName]);

  // Dependent insights fetch — only once the store is connected.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setLoadingAiInsights(true);
    fetch("/api/store/insights", { cache: "no-store" })
      .then((r) => r.json())
      .then((insights) => {
        if (cancelled) return;
        if (!insights.error) setAiInsights(insights);
        setLoadingAiInsights(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingAiInsights(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  return { storeInsights, aiInsights, loadingAiInsights };
}
