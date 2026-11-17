/**
 * Database capacity policy (Phase 1, task 10). Pure: thresholds, quota and
 * the per-entity storage costs measured in architecture/capacity-measurements.md
 * (local Postgres 17, synthetic shops of 500 to 70k products; costs include
 * indexes and are linear across that range).
 */

/** Alert levels, as a share of the database quota. */
export const WARNING_SHARE = 0.6;
export const CRITICAL_SHARE = 0.75;

/** Measured 3.9–4.8 KB per product on the task 12 schema (product, 3 variants, inventory levels, metafields, metrics). */
export const BYTES_PER_PRODUCT = 4_100;
/** Measured 0.80–0.87 KB per order on the task 12 schema (order, line items, customer share, refunds, returns, webhooks). */
export const BYTES_PER_ORDER = 880;
export const BYTES_PER_SHOP = 256 * 1024;
/** Room for row updates and dead tuples between vacuums. */
export const GROWTH_HEADROOM = 1.25;

const MIB = 1024 * 1024;
export const FREE_PLAN_QUOTA_MB = 500;

/** The plan's database quota: DATABASE_QUOTA_MB, else the Free plan's 500 MB. */
export function quotaBytes(value: string | undefined = process.env.DATABASE_QUOTA_MB): number {
  const mb = value === undefined || value.trim() === "" ? FREE_PLAN_QUOTA_MB : Number(value);
  if (!Number.isInteger(mb) || mb <= 0) throw new Error("DATABASE_QUOTA_MB must be a positive whole number of megabytes");
  return mb * MIB;
}

export type CapacityLevel = "ok" | "warning" | "critical";

export function capacityLevel(usedBytes: number, quota: number): CapacityLevel {
  const share = usedBytes / quota;
  return share >= CRITICAL_SHARE ? "critical" : share >= WARNING_SHARE ? "warning" : "ok";
}

/** Storage a full import of one shop is expected to add, with headroom. */
export function projectedImportBytes({ products, orders }: { products: number; orders: number }): number {
  if (!(products >= 0) || !(orders >= 0)) throw new Error("product and order counts must be non-negative");
  return Math.ceil((products * BYTES_PER_PRODUCT + orders * BYTES_PER_ORDER + BYTES_PER_SHOP) * GROWTH_HEADROOM);
}

export interface ImportPreflight {
  decision: "proceed" | "refuse";
  projected_bytes: number;
  projected_share: number;
  level_after: CapacityLevel;
  reason?: "capacity_exceeded";
}

/**
 * Whether a full historical import fits: refused when the database would pass
 * the critical share of its quota. A shop that fits but crosses the warning
 * share proceeds, and the daily snapshot raises the warning.
 */
export function importPreflight(input: { currentBytes: number; quota: number; products: number; orders: number }): ImportPreflight {
  const projected = projectedImportBytes(input);
  const after = input.currentBytes + projected;
  const share = Math.round((after / input.quota) * 10_000) / 10_000;
  const level = capacityLevel(after, input.quota);
  return level === "critical"
    ? { decision: "refuse", projected_bytes: projected, projected_share: share, level_after: level, reason: "capacity_exceeded" }
    : { decision: "proceed", projected_bytes: projected, projected_share: share, level_after: level };
}
