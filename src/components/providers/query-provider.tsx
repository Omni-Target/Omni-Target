"use client";

import * as React from "react";
import {
  QueryClient,
  QueryClientProvider,
  isServer,
} from "@tanstack/react-query";

// Shared client cache for the authenticated app. Owns credits, campaign
// history, and (progressively) the store-data/insights/dashboard-stats queries
// so navigation dedupes and mutations can keep every surface in sync.
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data is considered fresh for 30s — dedupes refetches across pages
        // that mount the same query during a single navigation session.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // Returning to a background tab re-syncs balance-critical data.
        refetchOnWindowFocus: true,
        retry: 1,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (isServer) {
    // Server renders must not share a client between requests.
    return makeQueryClient();
  }
  // Browser: reuse a single client so the cache survives client navigation.
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
