import "server-only";
import type { StoreData } from "@/lib/store-data";
import { supabaseAdmin } from "@/platform/supabase";
import { currentWorkspaceFor } from "@/modules/workspaces/current";
import { readShopInsights } from "./repository";

/**
 * The request side of the read path (Phase 2, task 11): the current
 * workspace's store snapshot as the worker last stored it. Requests never sync
 * with Shopify; they read this, and ask the worker for a newer one.
 */
export interface StoreInsightsRead {
  /** The user's current workspace is active and holds a shop. */
  connected: boolean;
  shopDomain: string | null;
  shopKey: number | null;
  data: StoreData | null;
  computedAt: string | null;
  grantedScopes: string[];
}

const disconnected: StoreInsightsRead = { connected: false, shopDomain: null, shopKey: null, data: null, computedAt: null, grantedScopes: [] };

export async function loadStoreInsights(userId: string): Promise<StoreInsightsRead> {
  const workspace = await currentWorkspaceFor(userId);
  if (!workspace || workspace.status !== "active" || !workspace.shop_domain) return disconnected;
  const { data: shop, error } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", workspace.shop_domain).maybeSingle();
  if (error) throw new Error(`shops read failed: ${error.message}`);
  if (!shop) return { ...disconnected, connected: true, shopDomain: workspace.shop_domain };
  const shopKey = Number(shop.shop_key);
  const [stored, access] = await Promise.all([
    readShopInsights(shopKey),
    supabaseAdmin.from("shop_access").select("granted_scopes").eq("shop_key", shopKey).maybeSingle(),
  ]);
  return {
    connected: true,
    shopDomain: workspace.shop_domain,
    shopKey,
    data: stored?.data ?? null,
    computedAt: stored?.computedAt ?? null,
    grantedScopes: ((access.data?.granted_scopes as string[] | null) ?? []),
  };
}

/** The current workspace's snapshot, or null while none is stored. */
export async function loadStoreSnapshot(userId: string): Promise<StoreData | null> {
  return (await loadStoreInsights(userId)).data;
}
