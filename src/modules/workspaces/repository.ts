import "server-only";
import { supabaseAdmin } from "@/platform/supabase";

/**
 * Workspace and shop-binding data access (Phase 1, task 3). Every write goes
 * through a database function from migration 0018, which enforces ownership,
 * lifecycle and concurrency rules; this module only names them and types
 * their results. The actor is always the authenticated Clerk user id, never
 * a value taken from the browser.
 */

export type ConnectOutcome =
  | "allowed"
  | "rejected_invalid_identity"
  | "rejected_deletion_in_progress"
  | "rejected_other_owner"
  | "rejected_legacy_claim_under_review"
  | "rejected_legacy_claim";

export type BindOutcome =
  | "bound_new_workspace"
  | "bound_existing_workspace"
  | "already_bound"
  | "reconnected"
  | "restored"
  | "rejected_invalid_identity"
  | "rejected_identity_conflict"
  | "rejected_deletion_in_progress"
  | "rejected_other_owner"
  | "rejected_legacy_claim_under_review"
  | "rejected_legacy_claim"
  | "rejected_workspace_ineligible";

export interface BindResult {
  outcome: BindOutcome;
  workspace_id?: string;
  shop_id?: string;
}

export type WorkspaceStatus = "active" | "disconnected" | "pending_deletion" | "deletion_processing" | "deleted";

export interface WorkspaceSummary {
  workspace_id: string;
  status: WorkspaceStatus;
  shop_domain: string | null;
  created_at: string;
}

export interface LifecycleEvent {
  shopifyShopId: number | null;
  domain: string;
  eventKey: string;
  triggeredAt: string | null;
}

export interface UninstallResult {
  outcome: "pending_deletion" | "already_pending" | "already_deleting" | "stale" | "no_workspace" | "duplicate";
  recorded_outcome?: string | null;
  workspace_id?: string;
}

export interface RedactResult {
  outcome: "deletion_started" | "deletion_already_running" | "no_workspace" | "duplicate";
  compliance_request_id?: string | null;
  deletion_id?: string | null;
  workspace_id?: string;
}

export interface DeletionResult {
  outcome: "completed" | "failed";
  workspace_id?: string;
  error?: string;
}

export type TransferStatus = "requested" | "verified" | "approved" | "completed" | "cancelled" | "expired";

/** Reasons a workspace function refuses, raised by the database. */
export const WORKSPACE_ERROR_CODES = [
  "workspace_access_denied",
  "shop_not_bound",
  "already_owner",
  "shop_not_transferable",
  "target_workspace_ineligible",
  "transfer_already_open",
  "transfer_access_denied",
  "transfer_not_found",
  "transfer_not_verifiable",
  "transfer_not_approvable",
  "transfer_not_approved",
  "transfer_shop_mismatch",
  "transfer_binding_changed",
  "campaign_not_found",
  "deletion_not_found",
  "compliance_request_not_found",
] as const;
export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode) {
    super(code);
    this.name = "WorkspaceError";
  }
}

const isMissingFunction = (error: { code?: string }) => error.code === "42883" || error.code === "PGRST202";

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) {
    const code = WORKSPACE_ERROR_CODES.find((known) => error.message?.includes(known));
    if (code) throw new WorkspaceError(code);
    throw new Error(`${fn} failed (${error.code ?? "unknown"})`);
  }
  return data as T;
}

// ── Connection ──────────────────────────────────────────────────────────────

/** Read-only check, by domain, before any OAuth code is exchanged. */
export async function preflightShopConnection(domain: string, actor: string): Promise<ConnectOutcome> {
  const result = await call<{ outcome: ConnectOutcome }>("shop_connection_preflight", { p_domain: domain, p_actor: actor });
  return result.outcome;
}

export function bindShopForInstall(input: {
  shopifyShopId: number;
  domain: string;
  actor: string;
  selectedWorkspaceId: string | null;
  shopName: string | null;
}): Promise<BindResult> {
  return call<BindResult>("bind_shop_for_install", {
    p_shopify_shop_id: input.shopifyShopId,
    p_domain: input.domain,
    p_actor: input.actor,
    p_selected_workspace: input.selectedWorkspaceId,
    p_shop_name: input.shopName,
  });
}

/** The actor's workspace that currently holds this shop and is active, if any. */
export async function activeWorkspaceForShop(domain: string, actor: string): Promise<string | null> {
  const workspaces = await listWorkspaces(actor);
  return workspaces.find((w) => w.shop_domain === domain && w.status === "active")?.workspace_id ?? null;
}

export function disconnectWorkspace(workspaceId: string, actor: string) {
  return call<{ outcome: "disconnected" | "not_active"; workspace_id?: string; status?: WorkspaceStatus; shop_domain: string | null }>(
    "disconnect_workspace",
    { p_workspace: workspaceId, p_actor: actor },
  );
}

// ── Lifecycle and compliance ────────────────────────────────────────────────

const lifecycleArgs = (event: LifecycleEvent) => ({
  p_shopify_shop_id: event.shopifyShopId,
  p_domain: event.domain,
  p_event_key: event.eventKey,
  p_triggered_at: event.triggeredAt,
});

export const beginUninstall = (event: LifecycleEvent) => call<UninstallResult>("begin_uninstall", lifecycleArgs(event));

export const recordShopRedact = (event: LifecycleEvent) => call<RedactResult>("record_shop_redact", lifecycleArgs(event));

export const recordCustomerCompliance = (topic: "customers/redact" | "customers/data_request", event: LifecycleEvent) =>
  call<{ outcome: "completed" | "duplicate"; compliance_request_id?: string }>("record_customer_compliance", {
    p_topic: topic,
    ...lifecycleArgs(event),
  });

export const processWorkspaceDeletion = (deletionId: string) =>
  call<DeletionResult>("process_workspace_deletion", { p_deletion: deletionId });

export const processUnboundShopRedact = (requestId: string) =>
  call<{ outcome: "completed" | "failed" | "has_workspace"; remaining?: number }>("process_unbound_shop_redact", { p_request: requestId });

/** Deletion work still open, oldest first: workspace deletions and shop/redact requests with no workspace. */
export async function listOpenDeletionWork(limit = 20): Promise<{ deletions: string[]; unboundRequests: string[] }> {
  const [deletions, requests] = await Promise.all([
    supabaseAdmin.from("workspace_deletions").select("id").neq("status", "completed").order("requested_at").limit(limit),
    supabaseAdmin
      .from("compliance_requests")
      .select("id")
      .eq("topic", "shop/redact")
      .neq("status", "completed")
      .is("workspace_id", null)
      .order("received_at")
      .limit(limit),
  ]);
  if (deletions.error) throw new Error(`workspace_deletions query failed (${deletions.error.code ?? "unknown"})`);
  if (requests.error) throw new Error(`compliance_requests query failed (${requests.error.code ?? "unknown"})`);
  return {
    deletions: (deletions.data as { id: string }[]).map((row) => row.id),
    unboundRequests: (requests.data as { id: string }[]).map((row) => row.id),
  };
}

/**
 * Whether Shopify work may run for a shop: false once its workspace is
 * disconnected, uninstalled or being deleted. A shop the workspace model does
 * not know yet keeps the legacy behaviour, as does a database without 0018.
 */
export async function shopOperationsAllowed(domain: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("shop_operations_allowed", { p_domain: domain });
  if (error) {
    if (isMissingFunction(error)) return true;
    throw new Error(`shop_operations_allowed failed (${error.code ?? "unknown"})`);
  }
  return data === true;
}

// ── Reads for an authenticated actor ────────────────────────────────────────

export const listWorkspaces = (actor: string) => call<WorkspaceSummary[]>("list_workspaces", { p_actor: actor });

export const workspaceForActor = (workspaceId: string, actor: string) =>
  call<WorkspaceSummary>("workspace_for_actor", { p_workspace: workspaceId, p_actor: actor });

// ── Ownership transfer ──────────────────────────────────────────────────────

export const requestOwnershipTransfer = (input: { domain: string; requester: string; targetWorkspaceId: string | null; reason: string | null }) =>
  call<{ outcome: "requested"; transfer_id: string }>("request_ownership_transfer", {
    p_domain: input.domain,
    p_requester: input.requester,
    p_target_workspace: input.targetWorkspaceId,
    p_reason: input.reason,
  });

export const verifyOwnershipTransfer = (transferId: string, requester: string, domain: string) =>
  call<{ outcome: "verified" }>("verify_ownership_transfer", { p_transfer: transferId, p_requester: requester, p_domain: domain });

export const approveOwnershipTransfer = (transferId: string, approver: string) =>
  call<{ outcome: "approved" }>("approve_ownership_transfer", { p_transfer: transferId, p_approver: approver });

export const completeOwnershipTransfer = (transferId: string, requester: string, shopifyShopId: number) =>
  call<{ outcome: "completed"; workspace_id: string; previous_workspace_id: string }>("complete_ownership_transfer", {
    p_transfer: transferId,
    p_requester: requester,
    p_shopify_shop_id: shopifyShopId,
  });

export const cancelOwnershipTransfer = (transferId: string, actor: string) =>
  call<{ outcome: string }>("cancel_ownership_transfer", { p_transfer: transferId, p_actor: actor });

export interface TransferView {
  id: string;
  status: TransferStatus;
  shop_domain: string;
  direction: "outgoing" | "incoming";
  reason: string | null;
  requested_at: string;
  shopify_verified_at: string | null;
  approved_at: string | null;
  expires_at: string;
}

type TransferRow = Omit<TransferView, "shop_domain" | "direction"> & {
  requested_by_clerk_user_id: string;
  from_workspace_id: string;
  shops: { myshopify_domain: string } | null;
};

const TRANSFER_COLUMNS =
  "id, status, reason, requested_at, shopify_verified_at, approved_at, expires_at, requested_by_clerk_user_id, from_workspace_id, shops(myshopify_domain)";

/** Transfers the actor requested, and requests for shops the actor owns. */
export async function listTransfersForActor(actor: string): Promise<TransferView[]> {
  const owned = (await listWorkspaces(actor)).map((w) => w.workspace_id);
  const outgoing = await supabaseAdmin.from("ownership_transfers").select(TRANSFER_COLUMNS).eq("requested_by_clerk_user_id", actor);
  if (outgoing.error) throw new Error(`ownership_transfers query failed (${outgoing.error.code ?? "unknown"})`);
  let incoming: TransferRow[] = [];
  if (owned.length > 0) {
    const result = await supabaseAdmin.from("ownership_transfers").select(TRANSFER_COLUMNS).in("from_workspace_id", owned);
    if (result.error) throw new Error(`ownership_transfers query failed (${result.error.code ?? "unknown"})`);
    incoming = result.data as unknown as TransferRow[];
  }
  const view = (row: TransferRow, direction: TransferView["direction"]): TransferView => ({
    id: row.id,
    status: row.status,
    shop_domain: row.shops?.myshopify_domain ?? "",
    direction,
    reason: row.reason,
    requested_at: row.requested_at,
    shopify_verified_at: row.shopify_verified_at,
    approved_at: row.approved_at,
    expires_at: row.expires_at,
  });
  return [
    ...(outgoing.data as unknown as TransferRow[]).map((row) => view(row, "outgoing")),
    ...incoming.filter((row) => row.requested_by_clerk_user_id !== actor).map((row) => view(row, "incoming")),
  ];
}

/** A transfer as its requester sees it, or null when it is not theirs. */
export async function transferForRequester(transferId: string, requester: string): Promise<{ status: TransferStatus; shop_domain: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("ownership_transfers")
    .select("status, shops(myshopify_domain)")
    .eq("id", transferId)
    .eq("requested_by_clerk_user_id", requester)
    .maybeSingle();
  if (error) throw new Error(`ownership_transfers query failed (${error.code ?? "unknown"})`);
  if (!data) return null;
  const row = data as unknown as { status: TransferStatus; shops: { myshopify_domain: string } | null };
  return { status: row.status, shop_domain: row.shops?.myshopify_domain ?? "" };
}
