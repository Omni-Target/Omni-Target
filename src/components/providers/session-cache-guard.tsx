"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { clearStoreCache, setStoreCacheOwner } from "@/lib/store-cache";
import { clearQueryCache } from "./query-provider";

/** Names the cache owner during render, so instant-load reads see it first. */
export function StoreCacheOwner({ userId, children }: { userId: string; children: React.ReactNode }) {
  setStoreCacheOwner(userId);
  return <>{children}</>;
}

/**
 * Clears cached store data whenever the session ends or changes user. Watching
 * Clerk's state covers every sign-out path, including one in another tab.
 */
export function SessionCacheGuard() {
  const { isLoaded, userId } = useAuth();
  const previousUser = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return;
    const previous = previousUser.current;
    previousUser.current = userId ?? null;
    if (!userId) {
      clearStoreCache();
      clearQueryCache();
    } else if (previous && previous !== userId) {
      clearQueryCache();
    }
  }, [isLoaded, userId]);

  return null;
}
