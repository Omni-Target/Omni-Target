import "server-only";
import { supabaseAdmin } from "@/platform/supabase";

/** Customer data request exports (migration 0037). Every call is one RPC as service_role. */

async function rpc<T>(fn: string, args: Record<string, unknown>, { allowNull = false } = {}): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  if (!allowNull && (data === null || data === undefined)) throw new Error(`${fn} failed: no result`);
  return data as T;
}

export type ExportClaim =
  | { outcome: "claimed"; shop_key: number; shop_domain: string; shopify_shop_id: number; customer_id: number | null; order_ids: number[]; received_at: string; due_at: string }
  | { outcome: "missing" | "ready" | "expired" | "withdrawn" | "busy" | "shop_missing" };

export interface ExportOrdersPage {
  orders: Array<Record<string, unknown>>;
  next_after: number | null;
}

export interface ExportRelated {
  meta_conversion_events: unknown[];
  pending_webhook_payloads: unknown[];
}

export type RecordedExport =
  | { outcome: "ready"; owner_clerk_user_id: string | null; shop_domain: string; expires_at: string }
  | { outcome: "missing" | "lost" | "pending" | "ready" | "expired" | "withdrawn" };

export interface ExportOwner {
  status: string;
  shop_domain: string;
  expires_at: string | null;
  owner_clerk_user_id: string | null;
}

export type CloseReason = "expired" | "shop_redacted" | "workspace_deleted" | "customer_redacted";

export interface DueExportAction {
  request_id: string;
  shop_domain: string;
  action: "withdraw" | "delete_file" | "escalate" | "expire" | "notify" | "dispatch";
  reason: CloseReason | null;
  object_key: string | null;
  due_at: string;
  level: 1 | 2 | 3 | null;
}

export type DownloadGrant =
  | { outcome: "authorized"; object_key: string; key_version: number; sha256: string; bytes: number; customer_id: number | null; shop_domain: string }
  | { outcome: "not_found" };

export interface OwnerExportRow {
  request_id: string;
  status: "pending" | "exporting" | "ready" | "expired" | "withdrawn";
  customer_shopify_id: number | null;
  order_count: number;
  received_at: string;
  due_at: string;
  exported_at: string | null;
  expires_at: string | null;
  download_count: number;
}

export const claimExport = (requestId: string, runId: string) =>
  rpc<ExportClaim>("claim_compliance_export", { p_request: requestId, p_run_id: runId, p_stale_seconds: 900 });

export const exportCustomer = (requestId: string, runId: string) =>
  rpc<Record<string, unknown> | null>("compliance_export_customer", { p_request: requestId, p_run_id: runId }, { allowNull: true });

export const exportOrders = (requestId: string, runId: string, after: number, limit = 200) =>
  rpc<ExportOrdersPage>("compliance_export_orders", { p_request: requestId, p_run_id: runId, p_after: after, p_limit: limit });

export const exportRelated = (requestId: string, runId: string) =>
  rpc<ExportRelated>("compliance_export_related", { p_request: requestId, p_run_id: runId });

export const recordExport = (requestId: string, runId: string, file: { objectKey: string; bytes: number; sha256: string; keyVersion: number; counts: Record<string, number> }) =>
  rpc<RecordedExport>("record_compliance_export", {
    p_request: requestId, p_run_id: runId, p_object_key: file.objectKey, p_bytes: file.bytes, p_sha256: file.sha256,
    p_key_version: file.keyVersion, p_counts: file.counts,
  });

export const failExport = (requestId: string, runId: string, error: string) =>
  rpc<{ outcome: string }>("fail_compliance_export", { p_request: requestId, p_run_id: runId, p_error: error.slice(0, 1000) });

export const markExportDispatched = (requestId: string, runId: string) =>
  rpc<{ outcome: string }>("mark_compliance_export_dispatched", { p_request: requestId, p_run_id: runId });

export const markExportNotified = (requestId: string) => rpc<{ outcome: "notified" | "not_ready" }>("mark_compliance_export_notified", { p_request: requestId });

export const exportOwner = (requestId: string) => rpc<ExportOwner | null>("compliance_export_owner", { p_request: requestId }, { allowNull: true });

export const closeExport = (requestId: string, reason: CloseReason) =>
  rpc<{ outcome: "closed" | "unchanged" }>("close_compliance_export", { p_request: requestId, p_reason: reason });

export const exportFileDeleted = (requestId: string, objectKey: string) =>
  rpc<{ outcome: string }>("compliance_export_file_deleted", { p_request: requestId, p_object_key: objectKey });

export const markEscalated = (requestId: string, level: number) =>
  rpc<{ outcome: string }>("mark_compliance_escalated", { p_request: requestId, p_level: level });

export const exportsDue = (limit = 200) => rpc<DueExportAction[]>("compliance_exports_due", { p_stale_seconds: 900, p_max_dispatches: 10, p_limit: limit });

export const authorizeDownload = (requestId: string, actor: string) =>
  rpc<DownloadGrant>("authorize_compliance_download", { p_request: requestId, p_actor: actor });

export const exportsForOwner = (actor: string, workspaceId: string) =>
  rpc<OwnerExportRow[]>("compliance_exports_for_owner", { p_actor: actor, p_workspace: workspaceId });

/** Which of these files an export row still names (ready, or closed and awaiting deletion). */
export async function referencedExportFiles(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const { data, error } = await supabaseAdmin.from("compliance_exports").select("object_key").in("object_key", keys);
  if (error) throw new Error(`compliance_exports read failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{ object_key: string | null }>).flatMap((row) => (row.object_key ? [row.object_key] : [])));
}
