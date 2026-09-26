import { useEffect, useRef } from "react";
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
  storeLoading: boolean;
  aiInsights: AiInsights | null;
  loadingAiInsights: boolean;
}

/**
 * Loads the connected store snapshot. Campaign-specific AI insights are
 * generated with the selected product, not speculatively on page load.
 */
export function useStoreInsights({
  onReauthRequired,
  onStoreName,
}: UseStoreInsightsParams): UseStoreInsightsResult {
  const { data: storeResponse, isPending: storeLoading } = useStoreData();
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

  return { storeInsights, storeLoading, aiInsights: null, loadingAiInsights: false };
}
