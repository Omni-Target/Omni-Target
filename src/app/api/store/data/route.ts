import { after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getValidShopifyToken } from "@/lib/shopify-token";
import { getMissingShopifyScopes } from "@/lib/shopify-config";
import { loadStoreInsights } from "@/modules/insights/read";
import { dispatchShopInsights, insightsWindow } from "@/modules/jobs/trigger";
import { createLogger } from "@/platform/logger";

export const dynamic = "force-dynamic";
// Reads only: the snapshot is built by a worker from the canonical mirror (Phase 2, task 11).
export const maxDuration = 15;

const log = createLogger({ module: "store-data" });

/**
 * Cache headers (fix 8.2). A forced refresh is never stored by the browser, so
 * a refresh the merchant explicitly asked for is never answered from an
 * earlier copy. An ordinary read may be stored but must be revalidated on
 * every use. Neither is cached by the CDN (the data is per user).
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

// A snapshot older than this is rebuilt (by the worker) when read.
const SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;
const SCHEMA_VERSION = 9;

/**
 * The current workspace's store snapshot. Never syncs with Shopify: when the
 * snapshot is missing, stale, or a refresh is forced, it asks the worker for a
 * new one and answers with what it has, marked `refreshing`.
 */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "true";
  const { userId } = await auth();
  if (!userId) return respond({ error: "Unauthorized" }, force, 401);

  const read = await loadStoreInsights(userId);
  if (!read.connected || !read.shopDomain) return respond({ connected: false, message: "Shopify store not connected" }, force);

  // Granted scopes come from the shop's access check; until one has run they are unknown, not missing.
  const missingShopifyScopes = read.grantedScopes.length ? getMissingShopifyScopes(read.grantedScopes) : [];
  const reauthMetadata = {
    needsReauthForOrders: missingShopifyScopes.includes("read_all_orders"),
    needsShopifyReauthorization: missingShopifyScopes.length > 0,
    missingShopifyScopes,
  };
  const data = read.data?.data_quality?.schema_version === SCHEMA_VERSION ? read.data : null;
  const age = read.computedAt ? Date.now() - Date.parse(read.computedAt) : Infinity;
  const refreshing = force || !data || age > SNAPSHOT_MAX_AGE_MS;

  if (refreshing) {
    // The worker reads Shopify with the shop's session: a dead one needs the merchant to reconnect.
    const token = await getValidShopifyToken(userId);
    if (token.status === "not_connected") return respond({ connected: false, message: "Shopify store not connected" }, force);
    if (token.status === "reauth_required") {
      return respond({ connected: false, reauthRequired: true, message: "Shopify session expired — please reconnect your store" }, force);
    }
    const shopDomain = read.shopDomain;
    const reason = force ? insightsWindow("user", Date.now(), 60_000) : insightsWindow("stale");
    after(() => dispatchShopInsights(shopDomain, reason).then((id) => log.info("Store snapshot requested", { force, dispatched: Boolean(id) })));
  }

  return respond({ connected: true, data, ...reauthMetadata, snapshotAt: read.computedAt ?? undefined, refreshing }, force);
}
