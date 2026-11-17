import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import { currentWorkspaceFor } from "@/modules/workspaces/current";
import type { CreativeHook } from "@/lib/brief-pdf-types";

/**
 * Campaign and brief data access (Phase 1, task 7). Campaigns stay
 * creator-only inside their workspace: every query requires both the session
 * user and the workspace they are working in, as resolved by the database
 * from the server-side session. A browser-supplied workspace, shop or user id
 * is never used.
 */

export interface TenantContext {
  userId: string;
  workspaceId: string;
}

/** The session user's current workspace, or null when they have none. */
export async function tenantFor(userId: string): Promise<TenantContext | null> {
  const workspace = await currentWorkspaceFor(userId);
  return workspace ? { userId, workspaceId: workspace.workspace_id } : null;
}

/** One campaign of this creator in this workspace; null when it is not theirs. */
export async function getCampaign(ctx: TenantContext, campaignId: string) {
  const { data, error } = await supabaseAdmin.from("campaigns").select("*").eq("id", campaignId).eq("workspace_id", ctx.workspaceId).eq("clerk_user_id", ctx.userId).maybeSingle();
  if (error) throw new Error("Could not load the campaign.");
  return data;
}

/** Launched campaigns for the dashboard, newest first, at most 100 (DATA-07), without the large brief blob. */
export async function listActiveCampaigns(ctx: TenantContext) {
  const { data, error } = await supabaseAdmin.from("campaigns")
    .select("id, brand_name, product_name, product_description, product_price, media_url, campaign_goal, headline, primary_text, description, cta, copywriter_note, status, created_at, launched_at")
    .eq("workspace_id", ctx.workspaceId).eq("clerk_user_id", ctx.userId)
    .in("status", ["active", "paused", "stopped"]).order("launched_at", { ascending: false }).limit(100);
  if (error) throw new Error("Could not load campaigns.");
  return data ?? [];
}

/** Saved briefs, newest first, each with its number of generation attempts. */
export async function listBriefCampaigns(ctx: TenantContext, limit = 100) {
  const { data, error } = await supabaseAdmin.from("campaigns").select("id, brand_name, product_name, product_description, product_price, media_url, headline, cta, status, created_at").eq("workspace_id", ctx.workspaceId).eq("clerk_user_id", ctx.userId).not("brief_data", "is", null).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error("Could not load saved briefs.");
  const rows = data ?? [];
  if (rows.length === 0) return rows.map((row) => ({ ...row, variation_count: 0 }));

  const { data: versions, error: versionError } = await supabaseAdmin.from("campaign_brief_versions").select("campaign_id").eq("workspace_id", ctx.workspaceId).eq("clerk_user_id", ctx.userId).in("campaign_id", rows.map((row) => row.id));
  if (versionError) return rows.map((row) => ({ ...row, variation_count: 1 }));
  const counts = new Map<string, number>();
  for (const version of versions ?? []) counts.set(version.campaign_id, (counts.get(version.campaign_id) ?? 0) + 1);
  return rows.map((row) => ({ ...row, variation_count: counts.get(row.id) ?? 0 }));
}

/** Every generation attempt of one campaign, oldest first. */
export async function getBriefVersions(ctx: TenantContext, campaignId: string) {
  const { data, error } = await supabaseAdmin.from("campaign_brief_versions").select("*").eq("campaign_id", campaignId).eq("workspace_id", ctx.workspaceId).eq("clerk_user_id", ctx.userId).order("attempt_number", { ascending: true });
  if (error) throw new Error("Could not load the brief versions.");
  return data ?? [];
}

async function readReceipt(ctx: TenantContext, requestId: string) {
  const { data, error } = await supabaseAdmin.from("brief_generation_receipts")
    .select("request_hash, response, workspace_id").eq("clerk_user_id", ctx.userId).eq("request_id", requestId).maybeSingle();
  if (error) throw new Error("Could not check the generation receipt.");
  // A receipt from another of the user's workspaces is not this workspace's result.
  if (data?.workspace_id && data.workspace_id !== ctx.workspaceId) return null;
  return data;
}

/** A completed generation for this request, before repeating any model call. */
export async function getGenerationReceipt(ctx: TenantContext, requestId: string, requestHash: string) {
  const receipt = await readReceipt(ctx, requestId);
  if (receipt && receipt.request_hash !== requestHash) throw new Error("idempotency_conflict");
  return receipt?.response ?? null;
}

/** A completed generation after the browser lost the response. */
export async function getGenerationReceiptById(ctx: TenantContext, requestId: string): Promise<Record<string, unknown> | null> {
  const response = (await readReceipt(ctx, requestId))?.response;
  return response && typeof response === "object" && !Array.isArray(response) ? (response as Record<string, unknown>) : null;
}

/** Keeps the chosen variation and the user's selections, through the atomic database function. */
export async function finalizeBriefVersion(ctx: TenantContext, campaignId: string, versionId: string, context: unknown, copy: unknown, status?: string) {
  if (!(await getCampaign(ctx, campaignId))) throw new Error("campaign_not_found");
  const { error } = await supabaseAdmin.rpc("finalize_brief_version", {
    p_user_id: ctx.userId, p_campaign_id: campaignId, p_version_id: versionId,
    p_context: context ?? {}, p_copy: copy ?? {}, p_status: status ?? null,
  });
  if (error) throw new Error(error.message);
}

/** Attaches later, verified hooks without rewriting the generation evidence. */
export async function saveRecoveredCreativeHooks(ctx: TenantContext, campaignId: string, versionId: string, hooks: CreativeHook[]) {
  const { data: version, error: readError } = await supabaseAdmin.from("campaign_brief_versions").select("brief_data").eq("id", versionId).eq("campaign_id", campaignId).eq("workspace_id", ctx.workspaceId).eq("clerk_user_id", ctx.userId).single();
  if (readError || !version) throw new Error("Brief version not found.");
  const existing = version.brief_data && typeof version.brief_data === "object" && !Array.isArray(version.brief_data)
    ? (version.brief_data as Record<string, unknown>)
    : {};
  const { data: updated, error: writeError } = await supabaseAdmin.from("campaign_brief_versions").update({ brief_data: { ...existing, recovered_creative_hooks: hooks } }).eq("id", versionId).eq("campaign_id", campaignId).eq("workspace_id", ctx.workspaceId).eq("clerk_user_id", ctx.userId).select("id").single();
  if (writeError || !updated) throw new Error("Recovered hooks could not be saved.");
}
