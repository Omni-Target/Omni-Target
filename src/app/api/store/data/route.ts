import { auth } from "@clerk/nextjs/server";
import { getUserIntegration, updateUserIntegration } from "@/lib/db";
import { fetchShopifyStoreData } from "@/lib/connectors/shopify";
import { getValidShopifyToken } from "@/lib/shopify-token";
import { getMissingShopifyScopes } from "@/lib/shopify-config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Requires Vercel Pro — falls back to 10s on free tier

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
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";

  // 1. Hot in-memory cache check (0.1ms response time, zero database queries)
  if (!force) {
    const cached = serverSnapshotCache.get(userId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const cachedSnapshotAt = (cached.data as { snapshotAt?: string })?.snapshotAt;
      const cachedAge = cachedSnapshotAt ? Date.now() - new Date(cachedSnapshotAt).getTime() : 0;
      const cachedSchemaVersion = (cached.data as { data?: { data_quality?: { schema_version?: number } } }).data?.data_quality?.schema_version;
      const cachedNeedsReauth = (cached.data as { needsShopifyReauthorization?: boolean; needsReauthForOrders?: boolean }).needsShopifyReauthorization ||
        (cached.data as { needsReauthForOrders?: boolean }).needsReauthForOrders;
      if (cachedAge < SNAPSHOT_MAX_AGE_MS && cachedSchemaVersion === 6 && !cachedNeedsReauth) {
        return Response.json(cached.data, {
          headers: {
            "Cache-Control": "private, max-age=60, stale-while-revalidate=120",
          },
        });
      }
    }
  }

  console.log("Store data request from userId:", userId, "force:", force);

  // 2. Get credits info & cached snapshot from Supabase
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

  if (!force && !isStale && creditsRow?.store_snapshot?.data_quality?.schema_version === 6) {
    const payload = {
      connected: true,
      data: creditsRow.store_snapshot,
      credits_balance: creditsRow?.credits_balance || 0,
      credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
      ...reauthMetadata,
      snapshotAt: creditsRow?.store_snapshot_at,
    };
    serverSnapshotCache.set(userId, { data: payload, timestamp: Date.now() });
    return Response.json(payload, {
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=120",
      },
    });
  }

  if (force) {
    serverSnapshotCache.delete(userId);
  }

  // Get a valid (auto-refreshed) Shopify token
  const tokenResult = await getValidShopifyToken(userId);

  if (tokenResult.status === "not_connected") {
    return Response.json({
      connected: false,
      message: "Shopify store not connected",
      credits_balance: creditsRow?.credits_balance || 0,
      credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
    });
  }

  if (tokenResult.status === "reauth_required") {
    // The Shopify refresh token is dead (expired or already rotated). The
    // merchant must reconnect — retrying with the stored token won't help.
    return Response.json({
      connected: false,
      reauthRequired: true,
      message: "Shopify session expired — please reconnect your store",
      credits_balance: creditsRow?.credits_balance || 0,
      credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
    });
  }

  try {
    const storeData = await fetchShopifyStoreData(
      tokenResult.shopUrl,
      tokenResult.accessToken,
      userId
    );

    console.log("Store data fetched:", {
      store: storeData.store,
      orderCount: storeData.orders.orders_last_30_days,
      productCount: storeData.products.length
    });

    // Save snapshot to Supabase
    try {
      await updateUserIntegration(userId!, {
        store_snapshot: storeData,
        store_snapshot_at: new Date().toISOString()
      });
      console.log("Snapshot saved successfully");
    } catch (error) {
      console.error("Snapshot save failed:", error);
    }

    const syncPayload = {
      connected: true,
      data: storeData,
      credits_balance: creditsRow?.credits_balance || 0,
      credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
      ...reauthMetadata,
      snapshotAt: new Date().toISOString(),
    };
    serverSnapshotCache.set(userId, { data: syncPayload, timestamp: Date.now() });
    return Response.json(syncPayload, {
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    console.error("Store data error:", error);
    // If Shopify sync fails but we have an existing snapshot in Supabase,
    // gracefully fall back to it so the founder's dashboard remains operational.
    if (creditsRow?.store_snapshot) {
      const fallbackPayload = {
        connected: true,
        data: creditsRow.store_snapshot,
        credits_balance: creditsRow?.credits_balance || 0,
        credits_unlimited_until: creditsRow?.credits_unlimited_until || null,
        ...reauthMetadata,
        snapshotAt: creditsRow?.store_snapshot_at,
      };
      return Response.json(fallbackPayload, {
        headers: {
          "Cache-Control": "private, max-age=60",
        },
      });
    }

    return Response.json(
      { error: "Failed to fetch store data" },
      { status: 500 }
    );
  }
}
