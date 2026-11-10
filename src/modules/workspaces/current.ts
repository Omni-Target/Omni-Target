import "server-only";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/platform/supabase";
import { serializeCookie, uuidOrNull } from "@/lib/shopify-oauth";

/**
 * The workspace an authenticated user is working in (Phase 1, task 4). A user
 * may own several workspaces, each with its own shop and credentials. The
 * browser may name a preference (cookie); the database honours it only for
 * the user's own workspace that is not being deleted, and otherwise picks the
 * most recently connected active workspace.
 */

export const WORKSPACE_COOKIE = "omnitarget_workspace";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export interface CurrentWorkspace {
  workspace_id: string;
  status: string;
  shop_domain: string | null;
}

async function preferredWorkspace(): Promise<string | null> {
  try {
    return uuidOrNull((await cookies()).get(WORKSPACE_COOKIE)?.value);
  } catch {
    return null; // Outside a request (scheduled jobs): no preference.
  }
}

export async function currentWorkspaceFor(userId: string, preferred?: string | null): Promise<CurrentWorkspace | null> {
  const { data, error } = await supabaseAdmin.rpc("current_workspace_for_actor", {
    p_actor: userId,
    p_preferred: preferred === undefined ? await preferredWorkspace() : preferred,
  });
  if (error) throw new Error(`current_workspace_for_actor failed (${error.code ?? "unknown"})`);
  return (data as CurrentWorkspace | null) ?? null;
}

export const workspaceCookie = (workspaceId: string) => serializeCookie(WORKSPACE_COOKIE, workspaceId, ONE_YEAR_SECONDS);

/** Whether the user's current workspace is active and holds a store. Reads no credential. */
export async function hasConnectedShop(userId: string): Promise<boolean> {
  const workspace = await currentWorkspaceFor(userId);
  return Boolean(workspace && workspace.status === "active" && workspace.shop_domain);
}
