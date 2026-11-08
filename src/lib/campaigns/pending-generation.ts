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

/**
 * Whether a failed generation response is final (show the error now) rather
 * than ambiguous (the brief may still have been saved, so poll the receipt).
 * 4xx responses are final; so is any response where the server states nothing
 * was charged (`charged: false`, e.g. AI targeting/hooks failed before commit).
 */
export function isDefinitiveGenerationResponse(status: number, body: unknown): boolean {
  if (status < 500) return true;
  return typeof body === "object" && body !== null && (body as { charged?: unknown }).charged === false;
}
