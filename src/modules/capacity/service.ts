import "server-only";
import { createLogger } from "@/platform/logger";
import { CRITICAL_SHARE, quotaBytes } from "./policy";
import { projectImport, type ShopCounts } from "./projection";
import { releaseReservation, renewReservation, reserveCapacity } from "./repository";

/**
 * Import capacity guard (Phase 2, task 5; migration 0033). Before an import
 * writes anything it reserves its projected bytes; while running it renews the
 * reservation with what it has written; it releases it when done or failed.
 * Concurrent imports are serialised in the database, so together they can
 * never pass the critical share of the quota.
 */
const log = createLogger({ module: "capacity" });
export const RESERVATION_TTL_SECONDS = 3_600;

export type ImportPurpose = "initial_import" | "history_import" | "reconcile";

export type ReserveResult =
  | { outcome: "reserved"; reservationId: string; existing: boolean; projectedBytes: number }
  | { outcome: "refused"; projectedBytes: number; usedBytes: number; outstandingBytes: number; limitBytes: number };

export async function reserveImportCapacity(shopKey: number, purpose: ImportPurpose, counts: ShopCounts): Promise<ReserveResult> {
  const projection = projectImport(counts);
  const result = await reserveCapacity({
    shopKey, purpose, bytes: projection.bytes, quotaBytes: quotaBytes(), criticalShare: CRITICAL_SHARE, ttlSeconds: RESERVATION_TTL_SECONDS,
    projection: { raw_bytes: projection.rawBytes, breakdown: projection.breakdown, counts },
  });
  if (result.outcome === "refused") {
    log.warn("Import refused: capacity", { shopKey, purpose, projected: projection.bytes, used: result.used_bytes, outstanding: result.outstanding_bytes, limit: result.limit_bytes });
    return {
      outcome: "refused", projectedBytes: projection.bytes, usedBytes: Number(result.used_bytes),
      outstandingBytes: Number(result.outstanding_bytes), limitBytes: Number(result.limit_bytes),
    };
  }
  log.info("Import capacity reserved", { shopKey, purpose, projected: projection.bytes, existing: result.existing });
  return { outcome: "reserved", reservationId: String(result.reservation_id), existing: Boolean(result.existing), projectedBytes: projection.bytes };
}

export interface RenewResult {
  outcome: "renewed" | "released" | "missing";
  overLimit: boolean;
  usedBytes: number;
  limitBytes: number;
}

/** Records progress and extends the lease; overLimit tells the import to stop. */
export async function renewImportCapacity(reservationId: string, writtenBytes: number): Promise<RenewResult> {
  const result = await renewReservation({
    reservationId, writtenBytes, quotaBytes: quotaBytes(), criticalShare: CRITICAL_SHARE, ttlSeconds: RESERVATION_TTL_SECONDS,
  });
  return { outcome: result.outcome, overLimit: Boolean(result.over_limit), usedBytes: Number(result.used_bytes), limitBytes: Number(result.limit_bytes) };
}

export const releaseImportCapacity = (reservationId: string, reason: "completed" | "failed" | "cancelled") =>
  releaseReservation(reservationId, reason);
