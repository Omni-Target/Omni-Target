import "server-only";
import type { ImportDomain } from "@/modules/capacity/projection";
import { supabaseAdmin } from "@/platform/supabase";

/** Shop import records, history staging and summary refreshes (migrations 0030 and 0034). */
type Json = Record<string, unknown>;

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** Records an import of these domains (default: all), unless one is already active for the shop (0039). */
export const requestImport = (shopKey: number, domains: ImportDomain[] | null = null) =>
  rpc<{ outcome: "requested" | "existing" | "not_ingestible"; import_id?: string; status?: string; dispatch_attempts?: number }>("request_shop_import", {
    p_shop_key: shopKey, p_domains: domains && domains.length ? domains : null,
  });

export const markImportDispatched = (importId: string, runId: string) => rpc<Json>("mark_import_dispatched", { p_import: importId, p_run_id: runId });

export type Claim =
  | { outcome: "claimed"; shop_key: number; shop_domain: string; shopify_shop_id: number; coverage: Json; window_start: string; domains: ImportDomain[] | null }
  | { outcome: "finished" | "busy" | "missing"; status?: string };
export const claimImport = (importId: string, runId: string) => rpc<Claim>("claim_shop_import", { p_import: importId, p_run_id: runId, p_stale_seconds: 900 });

/** When the import first started (database clock); kept across retries and takeovers. */
export async function importStartedAt(importId: string): Promise<Date> {
  const { data, error } = await supabaseAdmin.from("shop_imports").select("started_at").eq("id", importId).single();
  if (error || !data?.started_at) throw new Error(`shop_imports read failed: ${error?.message ?? "not started"}`);
  return new Date(data.started_at);
}

export const importHeartbeat = (importId: string, runId: string, coverage: Json | null = null) =>
  rpc<{ outcome: "ok" | "lost" }>("import_heartbeat", { p_import: importId, p_run_id: runId, p_coverage: coverage });

export const finishImport = (importId: string, runId: string | null, status: "succeeded" | "partial" | "failed" | "cancelled", coverage: Json | null, error: string | null) =>
  rpc<{ outcome: "finished" | "not_active" }>("finish_shop_import", { p_import: importId, p_run_id: runId, p_status: status, p_coverage: coverage, p_error: error });

export const importsNeedingDispatch = (graceSeconds: number, staleSeconds: number, limit = 50) =>
  rpc<Array<{ import_id: string; shop_domain: string; status: string; dispatch_attempts: number }>>("imports_needing_dispatch", {
    p_requested_grace_seconds: graceSeconds, p_stale_seconds: staleSeconds, p_limit: limit,
  });

// History staging, summaries and discards belong to the run holding the import (0035).
export const stageHistory = (importId: string, runId: string, orders: unknown[], lines: unknown[]) =>
  rpc<{ orders: number; lines: number; in_window: number; suppressed: number; customers: number }>("stage_history_orders", {
    p_import: importId, p_run_id: runId, p_orders: orders, p_lines: lines,
  });

export const historyMonths = (importId: string) => rpc<Array<{ month: string; orders: number }>>("history_stage_months", { p_import: importId });

export const summariseHistoryMonth = (importId: string, runId: string, month: string) =>
  rpc<{ product_months: number; store_months: number }>("summarise_history_month", { p_import: importId, p_run_id: runId, p_month: month, p_calc_version: 1 });

/**
 * Deletes an import's staged history in bounded steps until none is left: by the run holding it,
 * or with runId null once the import has finished (the reconcile job's cleanup).
 */
export async function discardHistory(importId: string, runId: string | null): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < 10_000; i++) {
    const step = await rpc<{ deleted: number; remaining: number }>("discard_history_stage", { p_import: importId, p_run_id: runId, p_limit: 20_000 });
    deleted += step.deleted;
    if (step.remaining === 0) return deleted;
  }
  throw new Error("discard_history_stage did not finish");
}
