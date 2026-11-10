import { auth } from "@clerk/nextjs/server";
import { getUserIntegration, updateUserIntegration } from "@/lib/db";
import { fetchShopifyStoreData } from "@/lib/connectors/shopify";
import { getValidShopifyToken } from "@/lib/shopify-token";
import { getMissingShopifyScopes } from "@/lib/shopify-config";
import { createLogger } from "@/platform/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Requires Vercel Pro — falls back to 10s on free tier

const log = createLogger({ module: "store-data" });

/**
 * Cache headers (fix 8.2). A forced sync is never stored by the browser, so a
 * refresh the merchant explicitly asked for is never answered from an earlier
 * copy. An ordinary snapshot may be stored but must be revalidated on every
 * use, so it can never outlive a forced refresh; reuse comes from the hot
 * server cache below. Neither is cached by the CDN (the data is per user).
 */
const FORCED_SYNC_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
} as const;
const SNAPSHOT_HEADERS = {
  "Cache-Control": "private, no-cache",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
} as const;

const respond = (body: unknown, force: boolean, status = 200) =>
  Response.json(body, { status, headers: force ? FORCED_SYNC_HEADERS : SNAPSHOT_HEADERS });

interface CacheEntry {
  data: Record<string, unknown>;
  timestamp: number;
}
// Hot in-memory cache to eliminate remote database latency on repeated requests
const serverSnapshotCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 600_000; // 10 minutes hot memory TTL
// Auto-sync threshold: if snapshot is older than 1 hour, auto-refresh from Shopify in background
const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function GET(request: Request) {
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";

  const { userId } = await auth();
  if (!userId) {
    return respond({ error: "Unauthorized" }, force, 401);
  }

  // 1. Hot in-memory cache check (0.1ms response time, zero database queries)
  if (!force) {
    const cached = serverSnapshotCache.get(userId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const cachedSnapshotAt = (cached.data as { snapshotAt?: string })?.snapshotAt;
      const cachedAge = cachedSnapshotAt ? Date.now() - new Date(cachedSnapshotAt).getTime() : 0;
      const cachedSchemaVersion = (cached.data as { data?: { data_quality?: { schema_version?: number } } }).data?.data_quality?.schema_version;
      const cachedNeedsReauth = (cached.data as { needsShopifyReauthorization?: boolean; needsReauthForOrders?: boolean }).needsShopifyReauthorization ||
        (cached.data as { needsReauthForOrders?: boolean }).needsReauthForOrders;
      if (cachedAge < SNAPSHOT_MAX_AGE_MS && cachedSchemaVersion === 9 && !cachedNeedsReauth) {
        return respond(cached.data, force);
      }
    }
  }

  log.info("Store data request", { force });

  // 2. Cached snapshot from Supabase. Credits are not part of this payload:
  //    the UI reads them from /api/user/credits (the workspace ledger).
  const creditsRow = await getUserIntegration(userId);

  const snapshotDate = creditsRow?.store_snapshot_at
    ? new Date(creditsRow.store_snapshot_at).getTime()
    : 0;
  const snapshotAge = snapshotDate ? Date.now() - snapshotDate : Infinity;
  const isStale = snapshotAge > SNAPSHOT_MAX_AGE_MS;

  // INSTANT CACHE HIT: If store data is already cached, NOT stale, and this is not a forced sync,
  // return immediately and warm the hot in-memory cache.
  const missingShopifyScopes = getMissingShopifyScopes(creditsRow?.shopify_scopes);
  const reauthMetadata = {
    needsReauthForOrders: missingShopifyScopes.includes("read_all_orders"),
    needsShopifyReauthorization: missingShopifyScopes.length > 0,
    missingShopifyScopes,
  };

  if (!force && !isStale && creditsRow?.store_snapshot?.data_quality?.schema_version === 9) {
    const payload = {
      connected: true,
      data: creditsRow.store_snapshot,
      ...reauthMetadata,
      snapshotAt: creditsRow?.store_snapshot_at,
    };
    serverSnapshotCache.set(userId, { data: payload, timestamp: Date.now() });
    return respond(payload, force);
  }

  if (force) {
    serverSnapshotCache.delete(userId);
  }

  // Get a valid (auto-refreshed) Shopify token
  const tokenResult = await getValidShopifyToken(userId);

  if (tokenResult.status === "not_connected") {
    return respond({ connected: false, message: "Shopify store not connected" }, force);
  }

  if (tokenResult.status === "reauth_required") {
    // The Shopify refresh token is dead (expired or already rotated). The
    // merchant must reconnect — retrying with the stored token won't help.
    return respond({ connected: false, reauthRequired: true, message: "Shopify session expired — please reconnect your store" }, force);
  }

  if (tokenResult.status === "temporarily_unavailable") {
    // Transient: keep showing the last sync rather than asking for a reconnect.
    if (creditsRow?.store_snapshot?.data_quality?.schema_version === 9) {
      return respond({ connected: true, data: creditsRow.store_snapshot, ...reauthMetadata, snapshotAt: creditsRow?.store_snapshot_at }, force);
    }
    return respond({ error: "Shopify is temporarily unavailable. Please retry shortly." }, force, 503);
  }

  try {
    const storeData = await fetchShopifyStoreData(
      tokenResult.shopUrl,
      tokenResult.accessToken,
      userId
    );

    log.info("Store data fetched", {
      force,
      orderCount: storeData.orders.orders_last_30_days,
      productCount: storeData.products.length,
    });

    // Save snapshot to Supabase
    try {
      await updateUserIntegration(userId!, {
        store_snapshot: storeData,
        store_snapshot_at: new Date().toISOString()
      });
    } catch (error) {
      log.error("Snapshot save failed", { force }, error);
    }

    const syncPayload = {
      connected: true,
      data: storeData,
      ...reauthMetadata,
      snapshotAt: new Date().toISOString(),
    };
    serverSnapshotCache.set(userId, { data: syncPayload, timestamp: Date.now() });
    return respond(syncPayload, force);
  } catch (error) {
    log.error("Store data sync failed", { force }, error);
    // If Shopify sync fails but we have an existing snapshot in Supabase,
    // gracefully fall back to it so the founder's dashboard remains operational.
    if (creditsRow?.store_snapshot) {
      return respond({ connected: true, data: creditsRow.store_snapshot, ...reauthMetadata, snapshotAt: creditsRow?.store_snapshot_at }, force);
    }

    return respond({ error: "Failed to fetch store data" }, force, 500);
  }
}
