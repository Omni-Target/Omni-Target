import "server-only";
import { createLogger } from "@/platform/logger";
import { supabaseAdmin } from "@/platform/supabase";
import { credentialAad, credentialKeyring, open, seal } from "@/platform/credentials/crypto";
import { currentWorkspaceFor } from "@/modules/workspaces/current";

/**
 * Meta credentials (Phase 1, task 4). They belong to a workspace: a Clerk user
 * who owns several workspaces connects Meta separately in each, and one
 * workspace can never read another's. Tokens are encrypted and bound to their
 * workspace and kind; ad-account and page listings are stored without tokens.
 */

const log = createLogger({ module: "meta-credentials" });
const GRAPH = "https://graph.facebook.com/v19.0";

type MetaKind = "user" | "page";

interface SealedMeta {
  key_version: number;
  ciphertext: string;
  nonce: string;
  tag: string;
  subject_id?: string | null;
  expires_at?: string | null;
}

export interface MetaPageListing {
  id: string;
  name: string | null;
}

export interface MetaConnectionInput {
  userToken: string;
  userTokenExpiresIn: number | null;
  adAccounts: Array<Record<string, unknown>>;
  /** As returned by Graph me/accounts; tokens are stripped before storage. */
  pages: Array<{ id?: string; name?: string; access_token?: string }>;
  adAccountId: string | null;
  pixelId: string | null;
  businessId: string | null;
}

export interface MetaAccess {
  workspaceId: string;
  userToken: string;
  pageToken: string | null;
  adAccountId: string | null;
  pixelId: string | null;
  pageId: string | null;
  pageName: string | null;
  adAccounts: Array<Record<string, unknown>>;
  pages: MetaPageListing[];
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) {
    if (error.message?.includes("workspace_access_denied")) throw new Error("workspace_access_denied");
    if (error.message?.includes("meta_asset_not_found")) throw new Error("meta_asset_not_found");
    throw new Error(`${fn} failed (${error.code ?? "unknown"})`);
  }
  return data as T;
}

function sealMeta(workspaceId: string, kind: MetaKind, token: string, subjectId: string | null, expiresIn: number | null): SealedMeta {
  const sealed = seal(token, credentialAad.meta(workspaceId, kind), credentialKeyring());
  return {
    key_version: sealed.keyVersion,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    tag: sealed.tag,
    subject_id: subjectId,
    expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
  };
}

function openMeta(workspaceId: string, kind: MetaKind, sealed: SealedMeta | null): string | null {
  if (!sealed) return null;
  return open({ keyVersion: sealed.key_version, ciphertext: sealed.ciphertext, nonce: sealed.nonce, tag: sealed.tag }, credentialAad.meta(workspaceId, kind));
}

const pageListing = (pages: MetaConnectionInput["pages"]): MetaPageListing[] =>
  pages.filter((page) => typeof page?.id === "string").map((page) => ({ id: page.id as string, name: page.name ?? null }));

/** Ad accounts as listed, without pixel code or anything resembling a token. */
function adAccountListing(accounts: MetaConnectionInput["adAccounts"]) {
  return accounts.map((account) => {
    const pixels = (account.adspixels as { data?: Array<{ id?: string; name?: string }> } | undefined)?.data ?? [];
    return {
      id: account.id,
      name: account.name ?? null,
      account_id: account.account_id ?? null,
      account_status: account.account_status ?? null,
      currency: account.currency ?? null,
      adspixels: { data: pixels.map((pixel) => ({ id: pixel.id, name: pixel.name ?? null })) },
    };
  });
}

/** Stores a new Meta connection for one workspace, replacing its previous one. */
export async function storeMetaConnection(workspaceId: string, actor: string, input: MetaConnectionInput): Promise<void> {
  const firstPage = input.pages.find((page) => typeof page?.id === "string");
  const pageToken = firstPage?.access_token
    ? sealMeta(workspaceId, "page", firstPage.access_token, firstPage.id ?? null, null)
    : null;
  await rpc("store_meta_connection", {
    p_workspace: workspaceId,
    p_actor: actor,
    p_user_credential: sealMeta(workspaceId, "user", input.userToken, null, input.userTokenExpiresIn),
    p_page_credential: pageToken,
    p_connection: {
      ad_accounts: adAccountListing(input.adAccounts),
      pages: pageListing(input.pages),
      ad_account_id: input.adAccountId,
      pixel_id: input.pixelId,
      business_id: input.businessId,
      page_id: firstPage?.id ?? null,
      page_name: firstPage?.name ?? null,
    },
  });
  log.info("Meta connection stored", { workspaceId, hasPageToken: Boolean(pageToken), keyVersion: credentialKeyring().currentVersion });
}

interface AccessRow {
  outcome: string;
  workspace_id: string;
  user: SealedMeta | null;
  page: SealedMeta | null;
  ad_account_id: string | null;
  pixel_id: string | null;
  page_id: string | null;
  page_name: string | null;
  ad_accounts: Array<Record<string, unknown>>;
  pages: MetaPageListing[];
}

/** Meta access for an owner's active workspace, or null. */
export async function getMetaAccess(workspaceId: string, actor: string): Promise<MetaAccess | null> {
  const row = await rpc<AccessRow>("meta_access_for_workspace", { p_workspace: workspaceId, p_actor: actor });
  if (row.outcome !== "ok" || !row.user) return null;
  return {
    workspaceId,
    userToken: openMeta(workspaceId, "user", row.user) as string,
    pageToken: openMeta(workspaceId, "page", row.page),
    adAccountId: row.ad_account_id,
    pixelId: row.pixel_id,
    pageId: row.page_id,
    pageName: row.page_name,
    adAccounts: row.ad_accounts ?? [],
    pages: row.pages ?? [],
  };
}

/** Meta access for the signed-in user's current workspace, or null. */
export async function getMetaAccessForUser(userId: string): Promise<MetaAccess | null> {
  const workspace = await currentWorkspaceFor(userId);
  return workspace ? getMetaAccess(workspace.workspace_id, userId) : null;
}

/** For an order webhook (Meta CAPI): the shop's own workspace, when it may operate. */
export async function getMetaAccessForShop(domain: string): Promise<{ workspaceId: string; owner: string; pixelId: string | null; userToken: string } | null> {
  const row = await rpc<{ outcome: string; workspace_id: string; owner: string; pixel_id: string | null; user: SealedMeta | null }>(
    "meta_access_for_shop",
    { p_domain: domain },
  );
  if (row.outcome !== "ok" || !row.user) return null;
  return { workspaceId: row.workspace_id, owner: row.owner, pixelId: row.pixel_id, userToken: openMeta(row.workspace_id, "user", row.user) as string };
}

export async function selectMetaAdAccount(workspaceId: string, actor: string, adAccountId: string): Promise<void> {
  await rpc("select_meta_ad_account", { p_workspace: workspaceId, p_actor: actor, p_ad_account_id: adAccountId });
}

/**
 * Selects a Page. Its token is fetched from Meta with the workspace's own user
 * token at selection time, so page tokens are never kept in listings.
 */
export async function selectMetaPage(workspaceId: string, actor: string, pageId: string): Promise<void> {
  const access = await getMetaAccess(workspaceId, actor);
  if (!access) throw new Error("workspace_access_denied");
  if (!access.pages.some((page) => page.id === pageId)) throw new Error("meta_asset_not_found");
  const response = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}?fields=access_token&access_token=${encodeURIComponent(access.userToken)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string };
  const pageToken = typeof body.access_token === "string" ? sealMeta(workspaceId, "page", body.access_token, pageId, null) : null;
  if (!pageToken) log.warn("Meta page selected without a page token", { workspaceId, status: response.status });
  await rpc("select_meta_page", { p_workspace: workspaceId, p_actor: actor, p_page_id: pageId, p_page_credential: pageToken });
}

export async function clearMetaConnection(workspaceId: string, actor: string): Promise<void> {
  await rpc("clear_meta_connection", { p_workspace: workspaceId, p_actor: actor });
  log.info("Meta connection cleared", { workspaceId });
}

/** Every Meta user token the owner holds, one per workspace (account deletion revokes each). */
export async function metaUserTokensForOwner(actor: string): Promise<Array<{ workspaceId: string; userToken: string }>> {
  const rows = await rpc<Array<SealedMeta & { workspace_id: string }>>("meta_user_credentials_for_owner", { p_actor: actor });
  return rows.map((row) => ({ workspaceId: row.workspace_id, userToken: openMeta(row.workspace_id, "user", row) as string }));
}
