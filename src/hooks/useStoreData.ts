import { useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * The shape returned by `/api/store/data`. `data` holds the store snapshot
 * (store/products/orders) when connected; the reauth flags signal a dead
 * Shopify session or an orders-scope gap.
 */
export interface StoreDataResponse {
  connected: boolean;
  data?: Record<string, unknown> | null;
  needsReauthForOrders?: boolean;
  reauthRequired?: boolean;
}

// Shared across dashboard / products / campaigns so navigating between them
// reads one cached snapshot instead of re-hitting Shopify on every mount.
export const STORE_DATA_QUERY_KEY = ["store-data"] as const;

export async function fetchStoreData(force = false): Promise<StoreDataResponse> {
  const res = await fetch(`/api/store/data${force ? "?force=true" : ""}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Store data failed (${res.status})`);
  return res.json();
}

/**
 * Reads the connected store's snapshot from the shared cache. The store data is
 * expensive (a Shopify round-trip) and changes rarely within a session, so it
 * gets a long `staleTime` — page-to-page navigation is served from cache.
 */
export function useStoreData(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: STORE_DATA_QUERY_KEY,
    queryFn: () => fetchStoreData(false),
    staleTime: 5 * 60_000,
    enabled: options?.enabled ?? true,
  });
}

/**
 * Returns a function that forces a fresh Shopify sync (`?force=true`) and writes
 * the result into the shared cache, so every consumer updates at once. Used by
 * the dashboard's refresh control.
 */
export function useForceSyncStoreData() {
  const queryClient = useQueryClient();
  return async (): Promise<StoreDataResponse> => {
    const data = await fetchStoreData(true);
    queryClient.setQueryData(STORE_DATA_QUERY_KEY, data);
    return data;
  };
}
