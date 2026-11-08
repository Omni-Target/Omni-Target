/**
 * Per-user browser cache of the store snapshot (SEC-11).
 *
 * The snapshot used to live under one fixed localStorage key that sign-out
 * never cleared, so the next person on a shared browser could see it. It is
 * now keyed by the signed-in user and removed on any sign-out.
 */
const KEY_PREFIX = "omni_store_data_v2:";
const LEGACY_KEY = "omni_store_data_v1";

let owner: string | null = null;

/** Called during render by the protected layout, before any reader runs. */
export function setStoreCacheOwner(userId: string): void {
  if (typeof window === "undefined") return; // module state must not cross requests
  owner = userId;
  try {
    localStorage.removeItem(LEGACY_KEY); // never read; don't leave it behind
  } catch {
    // Storage may be unavailable in private browsing.
  }
}

export function readStoreCache(): unknown {
  if (typeof window === "undefined" || !owner) return undefined;
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${owner}`);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoreCache(value: unknown): void {
  if (typeof window === "undefined" || !owner) return;
  try {
    localStorage.setItem(`${KEY_PREFIX}${owner}`, JSON.stringify(value));
  } catch {
    // Storage may be full or unavailable; the cache is only an optimization.
  }
}

/** Removes every user's cached snapshot, including the old shared key. */
export function clearStoreCache(): void {
  owner = null;
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(LEGACY_KEY);
    Object.keys(localStorage)
      .filter((key) => key.startsWith(KEY_PREFIX))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    // Storage may be unavailable in private browsing.
  }
}
