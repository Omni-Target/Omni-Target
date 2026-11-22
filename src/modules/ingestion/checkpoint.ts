/**
 * Which saved checkpoint an import may resume (Phase 2). Pure.
 *
 * A checkpoint names a bulk operation and the last line committed from its
 * result. Only the import that wrote it may resume it: a later import must run
 * its own bulk query, or it would re-read the earlier result (still
 * downloadable for 7 days) and import nothing new. Checkpoints and the
 * import's start both come from the database clock; a run taking over the same
 * import keeps the import's start, so retries and takeovers still resume.
 */
export interface SavedCheckpoint {
  bulkOperationId: number | null;
  committedLine: number;
  updatedAt: string | null;
}

export function resumableCheckpoint(saved: SavedCheckpoint | null, importStartedAt: Date): { operationId: string; line: number } | null {
  if (!saved?.bulkOperationId || !saved.updatedAt) return null;
  if (new Date(saved.updatedAt).getTime() < importStartedAt.getTime()) return null;
  return { operationId: `gid://shopify/BulkOperation/${saved.bulkOperationId}`, line: saved.committedLine };
}
