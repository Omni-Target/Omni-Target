export interface FetchRetryOptions {
  /** Per-attempt timeout before the request is aborted. Default 8s. */
  timeoutMs?: number;
  /** Number of RETRIES after the first attempt (so total attempts = retries + 1). Default 2. */
  retries?: number;
  /** Decide whether a (non-throwing) response is worth retrying. Default: 5xx or 429. */
  retryOn?: (res: Response) => boolean;
}

const defaultRetryOn = (res: Response) => res.status >= 500 || res.status === 429;

// Exponential backoff with light jitter: ~300ms, ~600ms, ~1200ms…
const backoff = (attempt: number) =>
  300 * 2 ** attempt + Math.floor(Math.random() * 150);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `fetch` with a per-attempt timeout (AbortController) and bounded retries for
 * transient upstream failures — network errors and 5xx/429 responses — with
 * exponential backoff. Intended for IDEMPOTENT requests (GETs / reads); do not
 * use it for non-idempotent writes where a retry could double-apply.
 *
 * Behaviour matches plain `fetch` on success: it resolves with the `Response`
 * (including a final failing one after retries are exhausted) and rejects only
 * if the last attempt threw (e.g. a timeout/abort or network error).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  { timeoutMs = 8000, retries = 2, retryOn = defaultRetryOn }: FetchRetryOptions = {},
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (attempt < retries && retryOn(res)) {
        await delay(backoff(attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await delay(backoff(attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable in practice — the loop either returns or throws — but satisfies
  // the type checker and guards against a misconfigured `retries`.
  throw lastError ?? new Error("fetchWithRetry: exhausted attempts");
}
