import { useEffect, useState } from "react";
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
 * Loads the connected store's data and — only if connected — its AI insights,
 * on mount.
 *
 * NOTE: the two fetches run as a WATERFALL (insights start only after store data
 * resolves as `connected`), preserved verbatim from the original. The
 * cross-domain effects — redirect on a dead session, brand-name prefill — are
 * surfaced via the `onReauthRequired` / `onStoreName` callbacks so this hook
 * stays focused on store/insights state. Callers MUST pass stable callbacks:
 * the load is a mount-only effect keyed on them.
 */
export function useStoreInsights({
  onReauthRequired,
  onStoreName,
}: UseStoreInsightsParams): UseStoreInsightsResult {
  const [storeInsights, setStoreInsights] = useState<StoreInsights | null>(
    null,
  );
  const [aiInsights, setAiInsights] = useState<AiInsights | null>(null);
  const [loadingAiInsights, setLoadingAiInsights] = useState(false);

  useEffect(() => {
    fetch("/api/store/data", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        // Dead Shopify session — hand off to the dashboard, which owns the
        // reconnect prompt, rather than silently showing placeholder data here.
        if (data.reauthRequired) {
          onReauthRequired();
          return;
        }
        if (data.connected && data.data) {
          setStoreInsights(data.data);
          if (data.data.store?.name) onStoreName(data.data.store.name);
          setLoadingAiInsights(true);
          fetch("/api/store/insights", { cache: "no-store" })
            .then((r) => r.json())
            .then((insights) => {
              if (!insights.error) setAiInsights(insights);
              setLoadingAiInsights(false);
            })
            .catch(() => setLoadingAiInsights(false));
        }
      })
      .catch(() => {});
  }, [onReauthRequired, onStoreName]);

  return { storeInsights, aiInsights, loadingAiInsights };
}
