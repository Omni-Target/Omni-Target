export const PENDING_GENERATION_KEY = "campaign_generation_pending_v1";

export interface PendingGeneration {
  requestId: string;
  userId: string | null;
  campaignId: string | null;
  startedAt: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePendingGeneration(raw: string | null): PendingGeneration | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const pending = value as Record<string, unknown>;
    if (typeof pending.requestId !== "string" || !UUID_PATTERN.test(pending.requestId) ||
        (pending.userId !== null && typeof pending.userId !== "string") ||
        (pending.campaignId !== null && (typeof pending.campaignId !== "string" || !UUID_PATTERN.test(pending.campaignId))) ||
        typeof pending.startedAt !== "number" || !Number.isFinite(pending.startedAt)) {
      return null;
    }
    return pending as unknown as PendingGeneration;
  } catch {
    return null;
  }
}

export function savePendingGeneration(pending: PendingGeneration): boolean {
  try {
    sessionStorage.setItem(PENDING_GENERATION_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingGeneration(): void {
  try {
    sessionStorage.removeItem(PENDING_GENERATION_KEY);
  } catch {
    // The storage entry was not writable, so there is nothing durable to clear.
  }
}
