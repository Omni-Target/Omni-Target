import "server-only";
import { collectDeniedFields, shopifyGraphql } from "@/lib/connectors/shopify-graphql";
import { getShopifyAccessForShop } from "@/modules/credentials/shopify";
import { createLogger } from "@/platform/logger";
import { ACCESS_PROBE_QUERY, assertLevel1Query, buildAccessReport, type AccessProbeData, type ShopAccessReport } from "./access";
import { recordShopAccess, shopKeyFor } from "./repository";

const log = createLogger({ module: "shopify-access" });

export type AccessCheck =
  | { outcome: "checked"; report: ShopAccessReport }
  | { outcome: "unknown_shop" | "not_connected" | "reauth_required" | "temporarily_unavailable" };

/**
 * Reads what a shop actually granted (scopes, the oldest reachable order and
 * every probed Level 1 and destination field) and stores it in shop_access.
 * Every import plans from this record, so nothing assumes access it lacks.
 */
export async function checkShopAccess(domain: string, now: Date = new Date()): Promise<AccessCheck> {
  const shopKey = await shopKeyFor(domain);
  if (shopKey === null) return { outcome: "unknown_shop" };
  const access = await getShopifyAccessForShop(domain);
  if (access.status !== "ok") return { outcome: access.status };

  assertLevel1Query(ACCESS_PROBE_QUERY);
  const { value, deniedFields } = await collectDeniedFields(() =>
    shopifyGraphql<AccessProbeData>(domain, access.accessToken, ACCESS_PROBE_QUERY),
  );
  const report = buildAccessReport(value, deniedFields, now);
  await recordShopAccess(shopKey, report);
  log.info("Shop access checked", {
    shop: domain,
    domains: Object.fromEntries(Object.entries(report.domains).map(([name, entry]) => [name, entry.status])),
    withheld: Object.keys(report.withheldFields).length,
    orderHistory: report.domains.orders.history?.basis ?? null,
  });
  return { outcome: "checked", report };
}
