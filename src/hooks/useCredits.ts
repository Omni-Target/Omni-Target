"use client";
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export interface CreditsData {
  credits_balance: number;
  is_unlimited: boolean;
  unlimited_until: string | null;
  shop: string | null;
}

export const CREDITS_QUERY_KEY = ["credits"] as const;

async function fetchCredits(): Promise<CreditsData> {
  const res = await fetch("/api/user/credits", {
    cache: "no-store",
    headers: {
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) throw new Error("Failed to load credits");
  return res.json();
}

/**
 * Reads the user's credit balance and connected store from the shared TanStack Query cache.
 * Every consumer (top bar, sidebar, pricing page, dashboard) shares one `["credits"]` query,
 * so a single fetch backs them all and a mutation-driven cache update reflects everywhere at once.
 * `refetchOnWindowFocus` and `refetchOnMount: "always"` ensure the balance stays synchronized across tabs.
 */
export function useCredits() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: CREDITS_QUERY_KEY,
    queryFn: fetchCredits,
    staleTime: 10_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  return {
    credits: data ? (data.credits_balance ?? 0) : null,
    credits_balance: data ? (data.credits_balance ?? 0) : 0,
    shop: data?.shop ?? null,
    isUnlimited: data?.is_unlimited ?? false,
    unlimitedUntil: data?.unlimited_until ? new Date(data.unlimited_until) : null,
    isLoading,
    isError,
    refetch,
  };
}

export function useInvalidateCredits() {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY });
  }, [queryClient]);
}

