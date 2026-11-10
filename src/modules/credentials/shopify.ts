import "server-only";
import { createLogger } from "@/platform/logger";
import { supabaseAdmin } from "@/platform/supabase";
import { credentialAad, credentialKeyring, needsReseal, open, seal, type SealedValue } from "@/platform/credentials/crypto";
import {
  REFRESH_LEASE_SECONDS,
  accessWithRefresh,
  classifyRefreshFailure,
  type AccessResult,
  type LoadedCredential,
  type RefreshResponse,
} from "./refresh";

/**
 * Shopify credentials (Phase 1, task 4). One encrypted credential per shop,
 * issued only to a workspace that owns the shop and may operate. Every Shopify
 * token in the application comes from here.
 */

const log = createLogger({ module: "shopify-credentials" });

interface SealedParts {
  ciphertext: string;
  nonce: string;
  tag: string;
}

/** The sealed form stored with the binding (commit_shop_install_under_lease) or on refresh. */
export interface SealedShopCredential {
  key_version: number;
  access: SealedParts;
  refresh: SealedParts | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string | null;
}

export interface ShopTokenInput {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  refreshExpiresIn?: number | null;
  scope: string | null;
}

const parts = (sealed: SealedValue): SealedParts => ({ ciphertext: sealed.ciphertext, nonce: sealed.nonce, tag: sealed.tag });
const isoIn = (seconds: number | null | undefined) => (seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null);

/** Encrypts a token pair for a shop, bound to Shopify's immutable shop id. */
export function sealShopCredential(shopifyShopId: number | string, token: ShopTokenInput): SealedShopCredential {
  const keyring = credentialKeyring();
  const access = seal(token.accessToken, credentialAad.shopify(shopifyShopId, "access"), keyring);
  const refresh = token.refreshToken ? seal(token.refreshToken, credentialAad.shopify(shopifyShopId, "refresh"), keyring) : null;
  return {
    key_version: access.keyVersion,
    access: parts(access),
    refresh: refresh && parts(refresh),
    access_expires_at: isoIn(token.expiresIn),
    refresh_expires_at: isoIn(token.refreshExpiresIn ?? null),
    scopes: token.scope ?? null,
  };
}

interface CredentialRow {
  outcome: "ok";
  shop_id: string;
  shopify_shop_id: string;
  shop_domain: string;
  workspace_id: string;
  version: number;
  key_version: number;
  status: "active" | "refresh_failed";
  access: SealedParts;
  refresh: SealedParts | null;
  access_expires_at: string | null;
}
type LookupResult = CredentialRow | { outcome: "access_denied" | "workspace_inactive" | "not_connected" | "not_modelled" };

function openRow(row: CredentialRow): LoadedCredential {
  const keyring = credentialKeyring();
  const sealedOf = (p: SealedParts): SealedValue => ({ ...p, keyVersion: row.key_version });
  return {
    shopId: row.shop_id,
    shopDomain: row.shop_domain,
    version: Number(row.version),
    status: row.status,
    accessToken: open(sealedOf(row.access), credentialAad.shopify(row.shopify_shop_id, "access"), keyring),
    refreshToken: row.refresh ? open(sealedOf(row.refresh), credentialAad.shopify(row.shopify_shop_id, "refresh"), keyring) : null,
    accessExpiresAt: row.access_expires_at ? Date.parse(row.access_expires_at) : null,
  };
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed (${error.code ?? "unknown"})`);
  return data as T;
}

/** Re-encrypts under the current key after a rotation. Best effort; never over a newer version. */
async function resealIfRotated(row: CredentialRow, loaded: LoadedCredential): Promise<void> {
  if (!needsReseal({ keyVersion: row.key_version })) return;
  const sealed = sealShopCredential(row.shopify_shop_id, { accessToken: loaded.accessToken, refreshToken: loaded.refreshToken, expiresIn: null, scope: null });
  const resealed = await rpc<boolean>("reseal_shop_credential", { p_shop: row.shop_id, p_expected_version: row.version, p_credential: sealed });
  if (resealed) log.info("Shopify credential re-encrypted under the current key", { shopId: row.shop_id, keyVersion: sealed.key_version });
}

async function refreshWithShopify(shopDomain: string, refreshToken: string): Promise<RefreshResponse> {
  try {
    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, ...classifyRefreshFailure(response.status, text) };
    const body = JSON.parse(text) as Record<string, unknown>;
    if (typeof body.access_token !== "string") return { ok: false, dead: false, error: "refresh_without_token" };
    return {
      ok: true,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
      refreshExpiresIn: typeof body.refresh_token_expires_in === "number" ? body.refresh_token_expires_in : null,
      scope: typeof body.scope === "string" ? body.scope : null,
    };
  } catch {
    return { ok: false, dead: false, error: "refresh_network_error" };
  }
}

async function access(lookup: () => Promise<LookupResult>): Promise<AccessResult> {
  const row = await lookup();
  if (row.outcome !== "ok") return { status: "not_connected" };
  const loaded = openRow(row);
  await resealIfRotated(row, loaded).catch((error) => log.warn("Credential re-encryption skipped", { shopId: row.shop_id }, error));

  return accessWithRefresh(loaded, {
    acquire: (shopId) =>
      rpc<string | null>("acquire_shop_lease", { p_key: `refresh:${shopId}`, p_purpose: "refresh", p_actor: "token-refresh", p_ttl_seconds: REFRESH_LEASE_SECONDS }),
    release: async (shopId, holder) => {
      await rpc("release_shop_lease", { p_key: `refresh:${shopId}`, p_holder: holder });
    },
    reload: async () => {
      const next = await lookup();
      return next.outcome === "ok" ? openRow(next) : null;
    },
    refresh: refreshWithShopify,
    store: async (shopId, holder, expectedVersion, response) => {
      const sealed = sealShopCredential(row.shopify_shop_id, response);
      const result = await rpc<{ outcome: "stored" | "stale" | "lease_lost" }>("store_refreshed_shop_credential", {
        p_shop: shopId,
        p_holder: holder,
        p_expected_version: expectedVersion,
        p_credential: sealed,
      });
      log.info("Shopify credential refresh", { shopId, outcome: result.outcome, keyVersion: sealed.key_version });
      return result.outcome;
    },
    recordFailure: async (shopId, expectedVersion, dead, error) => {
      await rpc("record_shop_refresh_failure", { p_shop: shopId, p_expected_version: expectedVersion, p_dead: dead, p_error: error });
      log.warn("Shopify credential refresh failed", { shopId, error, reconnectRequired: dead });
    },
    refreshDisabled: () => process.env.SHOPIFY_TOKEN_REFRESH_DISABLED === "true",
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
}

/** For an authenticated user acting in one of their workspaces. */
export const getShopifyAccessForWorkspace = (workspaceId: string, actor: string) =>
  access(() => rpc<LookupResult>("shop_credential_for_workspace", { p_workspace: workspaceId, p_actor: actor }));

/** For system work tied to a shop (webhooks, scheduled jobs). */
export const getShopifyAccessForShop = (domain: string) =>
  access(() => rpc<LookupResult>("shop_credential_for_shop", { p_domain: domain }));

export type { AccessResult as ShopifyAccess };
