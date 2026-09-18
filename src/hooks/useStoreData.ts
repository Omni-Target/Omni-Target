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
  snapshotAt?: string;
}

// Shared across dashboard / products / campaigns so navigating between them
// reads one cached snapshot instead of re-hitting Shopify on every mount.
export const STORE_DATA_QUERY_KEY = ["store-data"] as const;

const LOCAL_STORAGE_KEY = "omni_store_data_v1";

function getInitialStoreSnapshot(): StoreDataResponse | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.connected && parsed.data) {
      return parsed;
    }
  } catch {}
  return undefined;
}

function getInitialStoreUpdatedAt(): number {
  if (typeof window === "undefined") return 0;
  const snapshot = getInitialStoreSnapshot();
  if (snapshot?.snapshotAt) {
    const time = new Date(snapshot.snapshotAt).getTime();
    if (!isNaN(time) && time > 0) return time;
  }
  return 0;
}

export async function fetchStoreData(force = false): Promise<StoreDataResponse> {
  const res = await fetch(`/api/store/data${force ? "?force=true" : ""}`, {
    cache: force ? "no-store" : "default",
  });
  if (!res.ok) throw new Error(`Store data failed (${res.status})`);
  const json: StoreDataResponse = await res.json();
  if (typeof window !== "undefined" && json && json.connected && json.data) {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(json));
    } catch {}
  }
  return json;
}

/**
 * Reads the connected store's snapshot from the shared cache.
 * Uses localStorage for 0ms instant render on page loads, then automatically
 * background-revalidates with Shopify when the snapshot is stale.
 */
export function useStoreData(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: STORE_DATA_QUERY_KEY,
    queryFn: () => fetchStoreData(false),
    initialData: getInitialStoreSnapshot,
    initialDataUpdatedAt: getInitialStoreUpdatedAt,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: true,
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
