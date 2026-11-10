import { getShopifyAccessForShop, getShopifyAccessForWorkspace } from "@/modules/credentials/shopify";
import { currentWorkspaceFor } from "@/modules/workspaces/current";

/**
 * Shopify access tokens for the rest of the application (Phase 1, task 4).
 *
 * Credentials belong to a shop and are stored encrypted (shop_credentials).
 * A token is issued only to a workspace that owns its shop and may operate:
 * never for a disconnected, uninstalled, deleting or deleted workspace, and
 * never across workspaces or users. Expiring tokens are refreshed under a
 * per-shop lease (see src/modules/credentials/refresh.ts).
 *
 * - `ok`: a usable access token for the workspace's shop.
 * - `not_connected`: no issuable credential (no workspace, not connected, or
 *   the workspace may not operate).
 * - `reauth_required`: Shopify rejected the refresh token; reconnect.
 * - `temporarily_unavailable`: refresh failed transiently; retry shortly.
 */
export type ShopifyTokenResult =
  | { status: "ok"; accessToken: string; shopUrl: string }
  | { status: "not_connected" }
  | { status: "reauth_required"; shopUrl: string }
  | { status: "temporarily_unavailable"; shopUrl: string };

/**
 * The token for a signed-in user's workspace: the one named, or the user's
 * current workspace (their validated preference, else the most recently
 * connected active one).
 */
export async function getValidShopifyToken(userId: string, workspaceId?: string | null): Promise<ShopifyTokenResult> {
  const workspace = workspaceId ?? (await currentWorkspaceFor(userId))?.workspace_id;
  if (!workspace) return { status: "not_connected" };
  return getShopifyAccessForWorkspace(workspace, userId);
}

/** The token for system work tied to a shop (webhooks, scheduled jobs). */
export function getShopifyTokenForShop(shopDomain: string): Promise<ShopifyTokenResult> {
  return getShopifyAccessForShop(shopDomain);
}
