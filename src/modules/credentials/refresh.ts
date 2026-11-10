/**
 * Shopify token refresh under a per-shop lease (Phase 1, task 4).
 *
 * Shopify refresh tokens rotate: a refresh returns a new pair and retires the
 * previous refresh token once the replacement is used. Two workers refreshing
 * the same shop could therefore leave each other holding retired tokens. So:
 *
 *   * only the holder of the shop's 'refresh' lease (a database row, shared by
 *     every instance) calls Shopify;
 *   * the holder re-reads the credential under the lease and skips the call if
 *     someone else already refreshed it;
 *   * the new pair is stored only over the version that was refreshed
 *     (compare-and-swap), so a stale worker never overwrites a newer token;
 *   * workers without the lease wait, then use whatever the holder stored;
 *   * a failure never deletes the credential: a definitively rejected refresh
 *     token marks it for reconnection, a transient failure keeps using the
 *     current access token while it is still valid.
 *
 * Pure orchestration: the database, Shopify and the clock are injected.
 */

export const REFRESH_MARGIN_MS = 5 * 60_000;
export const REFRESH_LEASE_SECONDS = 30;

export interface LoadedCredential {
  shopId: string;
  shopDomain: string;
  version: number;
  status: "active" | "refresh_failed";
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number | null;
}

export type RefreshResponse =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresIn: number | null; refreshExpiresIn: number | null; scope: string | null }
  | { ok: false; dead: boolean; error: string };

export type AccessResult =
  | { status: "ok"; accessToken: string; shopUrl: string }
  | { status: "not_connected" }
  | { status: "reauth_required"; shopUrl: string }
  | { status: "temporarily_unavailable"; shopUrl: string };

export interface RefreshPorts {
  acquire(shopId: string): Promise<string | null>;
  release(shopId: string, holder: string): Promise<void>;
  /** The current credential through the same lifecycle-checked lookup, or null if no longer issuable. */
  reload(): Promise<LoadedCredential | null>;
  refresh(shopDomain: string, refreshToken: string): Promise<RefreshResponse>;
  store(shopId: string, holder: string, expectedVersion: number, response: Extract<RefreshResponse, { ok: true }>): Promise<"stored" | "stale" | "lease_lost">;
  recordFailure(shopId: string, expectedVersion: number, dead: boolean, error: string): Promise<void>;
  refreshDisabled(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RefreshOptions {
  attempts: number;
  pollMs: number;
}

const ok = (c: LoadedCredential): AccessResult => ({ status: "ok", accessToken: c.accessToken, shopUrl: c.shopDomain });
const usable = (c: LoadedCredential, now: number) => c.accessExpiresAt === null || c.accessExpiresAt > now;
export const isFresh = (c: LoadedCredential, now: number) => c.accessExpiresAt === null || c.accessExpiresAt - now > REFRESH_MARGIN_MS;

function stillUsableOr(c: LoadedCredential, now: number, otherwise: "reauth_required" | "temporarily_unavailable"): AccessResult {
  return usable(c, now) ? ok(c) : { status: otherwise, shopUrl: c.shopDomain };
}

export async function accessWithRefresh(
  initial: LoadedCredential,
  ports: RefreshPorts,
  options: RefreshOptions = { attempts: 20, pollMs: 250 },
): Promise<AccessResult> {
  if (initial.status === "refresh_failed") return { status: "reauth_required", shopUrl: initial.shopDomain };
  if (isFresh(initial, ports.now())) return ok(initial);
  if (!initial.refreshToken) return stillUsableOr(initial, ports.now(), "reauth_required");
  if (ports.refreshDisabled()) return stillUsableOr(initial, ports.now(), "temporarily_unavailable");

  let holder: string | null = null;
  for (let attempt = 0; attempt < options.attempts && !holder; attempt++) {
    if (attempt > 0) {
      await ports.sleep(options.pollMs);
      const latest = await ports.reload();
      if (!latest) return { status: "not_connected" };
      if (latest.version !== initial.version && isFresh(latest, ports.now())) return ok(latest);
    }
    holder = await ports.acquire(initial.shopId);
  }
  if (!holder) {
    const latest = await ports.reload();
    return latest ? stillUsableOr(latest, ports.now(), "temporarily_unavailable") : { status: "not_connected" };
  }

  try {
    const current = await ports.reload();
    if (!current) return { status: "not_connected" };
    if (current.status === "refresh_failed") return { status: "reauth_required", shopUrl: current.shopDomain };
    if (isFresh(current, ports.now())) return ok(current);
    if (!current.refreshToken) return stillUsableOr(current, ports.now(), "reauth_required");

    const response = await ports.refresh(current.shopDomain, current.refreshToken);
    if (response.ok) {
      // Keep the current refresh token if Shopify ever answers without a new one.
      const pair = { ...response, refreshToken: response.refreshToken ?? current.refreshToken };
      const stored = await ports.store(current.shopId, holder, current.version, pair);
      if (stored === "stored") return { status: "ok", accessToken: response.accessToken, shopUrl: current.shopDomain };
      // Another writer (a reconnection, or a worker that took over) stored a newer credential.
      const latest = await ports.reload();
      return latest ? stillUsableOr(latest, ports.now(), "temporarily_unavailable") : { status: "not_connected" };
    }

    const latest = await ports.reload();
    if (latest && latest.version !== current.version) return stillUsableOr(latest, ports.now(), "temporarily_unavailable");
    await ports.recordFailure(current.shopId, current.version, response.dead, response.error);
    if (response.dead) return { status: "reauth_required", shopUrl: current.shopDomain };
    return stillUsableOr(current, ports.now(), "temporarily_unavailable");
  } finally {
    await ports.release(initial.shopId, holder).catch(() => undefined);
  }
}

/** Shopify's answer to a refresh, classified without keeping any response body. */
export function classifyRefreshFailure(status: number, body: string): { dead: boolean; error: string } {
  const dead = (status === 400 || status === 401) && /invalid_request|invalid_grant|active refresh_token/i.test(body);
  return { dead, error: dead ? `refresh_rejected_${status}` : `refresh_failed_${status}` };
}
