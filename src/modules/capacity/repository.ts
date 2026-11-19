import "server-only";
import { supabaseAdmin } from "@/platform/supabase";

export interface CapacitySnapshot {
  captured_at: string;
  database_bytes: number;
  public_bytes: number;
  quota_bytes: number;
  used_share: number;
  largest: Array<{ table: string; rows: number; heap: number; indexes: number; total: number }>;
}

/** Records today's sizes (migration 0027) and returns them. */
export async function captureCapacitySnapshot(quotaBytes: number): Promise<CapacitySnapshot> {
  const { data, error } = await supabaseAdmin.rpc("capture_capacity_snapshot", { p_quota_bytes: quotaBytes });
  if (error || !data) throw new Error(`Capacity snapshot failed: ${error?.message ?? "no result"}`);
  return data as CapacitySnapshot;
}

/** Daily housekeeping (migration 0028): stale rate-limit windows and old webhook dedupe keys. */
export async function pruneOperationalRows(): Promise<{ rate_limits: number; webhook_deliveries: number }> {
  const { data, error } = await supabaseAdmin.rpc("prune_operational_rows");
  if (error || !data) throw new Error(`Housekeeping failed: ${error?.message ?? "no result"}`);
  return data as { rate_limits: number; webhook_deliveries: number };
}

type Json = Record<string, unknown>;

/** reserve_import_capacity (0033): granted or refused under one database-wide lock. */
export async function reserveCapacity(input: {
  shopKey: number; purpose: string; bytes: number; quotaBytes: number; criticalShare: number; ttlSeconds: number; projection: Json;
}): Promise<Json & { outcome: "reserved" | "refused" }> {
  const { data, error } = await supabaseAdmin.rpc("reserve_import_capacity", {
    p_shop_key: input.shopKey, p_purpose: input.purpose, p_bytes: input.bytes, p_quota_bytes: input.quotaBytes,
    p_critical_share: input.criticalShare, p_ttl_seconds: input.ttlSeconds, p_projection: input.projection,
  });
  if (error || !data) throw new Error(`Capacity reservation failed: ${error?.message ?? "no result"}`);
  return data as Json & { outcome: "reserved" | "refused" };
}

export async function renewReservation(input: {
  reservationId: string; writtenBytes: number; quotaBytes: number; criticalShare: number; ttlSeconds: number;
}): Promise<Json & { outcome: "renewed" | "released" | "missing" }> {
  const { data, error } = await supabaseAdmin.rpc("renew_import_capacity", {
    p_reservation: input.reservationId, p_written_bytes: Math.max(0, Math.round(input.writtenBytes)), p_quota_bytes: input.quotaBytes,
    p_critical_share: input.criticalShare, p_ttl_seconds: input.ttlSeconds,
  });
  if (error || !data) throw new Error(`Capacity renewal failed: ${error?.message ?? "no result"}`);
  return data as Json & { outcome: "renewed" | "released" | "missing" };
}

export async function releaseReservation(reservationId: string, reason: "completed" | "failed" | "cancelled"): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc("release_import_capacity", { p_reservation: reservationId, p_reason: reason });
  if (error || !data) throw new Error(`Capacity release failed: ${error?.message ?? "no result"}`);
  return String((data as Json).outcome);
}

export async function databaseSizeBytes(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("database_size_bytes");
  if (error || data === null || data === undefined) throw new Error(`Database size unavailable: ${error?.message ?? "no result"}`);
  return Number(data);
}
