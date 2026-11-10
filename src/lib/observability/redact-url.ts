/**
 * Redacts credentials carried in URLs before they reach a log, an error
 * report or a breadcrumb (fix 8.1). Sign-in tickets, OAuth authorization
 * codes, OAuth state, HMAC signatures and similar callback parameters are
 * replaced; everything else in the URL is kept for correlation.
 *
 * Shared by the structured logger and Sentry (through scrubText), and by
 * next.config for the development request log.
 */

const FILTERED = "[Filtered]";

/** Query or fragment parameters that authenticate a request or can be exchanged for access. */
export const SENSITIVE_URL_PARAMS = new Set([
  "token",
  "ticket",
  "__clerk_ticket",
  "__clerk_db_jwt",
  "code",
  "state",
  "hmac",
  "signature",
  "sig",
  "id_token",
  "access_token",
  "refresh_token",
  "client_secret",
  "session_token",
]);

/**
 * Routes whose URLs carry such parameters by design. Next.js prints every
 * incoming request in development and cannot redact them, so these are left
 * out of that log (next.config `logging.incomingRequests.ignore`).
 */
export const SENSITIVE_CALLBACK_PATHS: RegExp[] = [
  /^\/auth\/shopify-callback/,
  /^\/api\/auth\/shopify\/callback/,
  /^\/api\/auth\/meta\/callback/,
  /^\/api\/shopify\/billing\/callback/,
  /^\/api\/payments\/paystack\/verify/,
];

/** Replaces the value of every sensitive parameter in a query string or fragment ("a=1&code=x"). */
export function redactParams(params: string): string {
  return params
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      if (separator < 0) return pair;
      const rawKey = pair.slice(0, separator);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // A malformed key is compared as written.
      }
      return SENSITIVE_URL_PARAMS.has(key.toLowerCase()) ? `${rawKey}=${FILTERED}` : pair;
    })
    .join("&");
}

/** A URL or path with its sensitive query and fragment parameters redacted. */
export function redactUrl(url: string): string {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const fragment = hashAt < 0 ? null : url.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt < 0 ? null : beforeHash.slice(queryAt + 1);
  return `${base}${query === null ? "" : `?${redactParams(query)}`}${fragment === null ? "" : `#${redactParams(fragment)}`}`;
}

/**
 * Redacts relative paths with a query or fragment found in free text, such as
 * "GET /auth/shopify-callback?token=… 200" or a navigation breadcrumb.
 * Absolute URLs are handled separately (their whole query is removed).
 */
export function redactRelativeUrls(text: string): string {
  return text.replace(/(^|[\s"'(=,])(\/[^\s?#"'()]*[?#][^\s"'()]*)/g, (_match, lead: string, path: string) => `${lead}${redactUrl(path)}`);
}

/**
 * The sign-in ticket and destination handed to /auth/shopify-callback. They
 * travel in the URL fragment, which browsers never send to a server, so the
 * ticket cannot reach any request log; the query string is still read for a
 * link issued before this change.
 */
export function readTicketParams(hash: string, search: string): { token: string | null; destination: string | null } {
  const fromHash = new URLSearchParams(hash.replace(/^#/, ""));
  const fromQuery = new URLSearchParams(search.replace(/^\?/, ""));
  return {
    token: fromHash.get("token") ?? fromQuery.get("token"),
    destination: fromHash.get("destination") ?? fromQuery.get("destination"),
  };
}
