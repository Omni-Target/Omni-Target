"use client";
import { useQuery } from "@tanstack/react-query";

export interface CreditsData {
  credits_balance: number;
  is_unlimited: boolean;
  unlimited_until: string | null;
  shop: string | null;
}

export const CREDITS_QUERY_KEY = ["credits"] as const;

async function fetchCredits(): Promise<CreditsData> {
  const res = await fetch("/api/user/credits");
  if (!res.ok) throw new Error("Failed to load credits");
  return res.json();
}

/**
 * Reads the user's credit balance from the shared TanStack Query cache. Every
 * consumer (top bar, sidebar) shares one `["credits"]` query, so a single fetch
 * backs them all and a mutation-driven cache update reflects everywhere at once.
 * `refetchOnWindowFocus` (set on the QueryClient) also re-syncs the balance when
 * the user returns to a backgrounded tab.
 */
export function useCredits() {
  const { data } = useQuery({
    queryKey: CREDITS_QUERY_KEY,
    queryFn: fetchCredits,
  });

  return {
    credits: data ? (data.credits_balance ?? 0) : null,
    isUnlimited: data?.is_unlimited ?? false,
    unlimitedUntil: data?.unlimited_until ? new Date(data.unlimited_until) : null,
  };
}
