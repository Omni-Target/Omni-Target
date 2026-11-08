/**
 * Redirect-target allow-list (Phase S0.3 — SEC-03).
 *
 * Any destination that arrives in a URL (e.g. `?destination=` on the public
 * /auth/shopify-callback page) is attacker-controllable. Assigning it to
 * `window.location.href` allowed `javascript:` execution and open redirects.
 * Only same-origin, relative paths under known app sections are accepted;
 * everything else falls back to a safe default.
 *
 * Isomorphic: no browser or Node APIs beyond WHATWG URL.
 */
const ALLOWED_PREFIXES = [
  "/dashboard",
  "/onboarding",
  "/products",
  "/campaigns",
  "/briefs",
  "/pricing",
  "/settings",
] as const;

const PROBE_ORIGIN = "https://omnitarget.invalid";

export const DEFAULT_POST_AUTH_PATH = "/onboarding/audit";

export function safeInternalPath(input: unknown, fallback: string = DEFAULT_POST_AUTH_PATH): string {
  if (typeof input !== "string") return fallback;
  const value = input.trim();
  // Must be a root-relative path. Reject protocol-relative (//host), backslash
  // tricks (/\host, \\host), schemes (javascript:, data:, https:) and control chars.
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (parsed.origin !== PROBE_ORIGIN) return fallback;

  const path = parsed.pathname;
  const allowed = ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (!allowed) return fallback;

  return `${path}${parsed.search}${parsed.hash}`;
}
