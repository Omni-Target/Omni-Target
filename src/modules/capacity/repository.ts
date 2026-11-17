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

export async function databaseSizeBytes(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("database_size_bytes");
  if (error || data === null || data === undefined) throw new Error(`Database size unavailable: ${error?.message ?? "no result"}`);
  return Number(data);
}
