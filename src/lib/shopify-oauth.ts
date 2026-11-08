/**
 * Shopify OAuth security primitives (Phase S0.3 — SEC-01).
 *
 * The OAuth `state` parameter round-trips through Shopify unchanged, and the
 * callback HMAC only proves that Shopify signed whatever `state` the caller
 * supplied. Nothing that arrives in the callback URL may therefore decide
 * *which Omnitarget account* is signed in or linked. These helpers implement:
 *
 *   - An opaque random `state` nonce bound to an HMAC-signed, httpOnly cookie
 *     that also carries the flow context (shop, origin, plan, initiating user).
 *   - Constant-time verification of the Shopify callback HMAC.
 *   - Strict `*.myshopify.com` host validation and timestamp freshness.
 *   - A pending-install cookie for installs that arrive without a session; it
 *     carries only the shop so the flow can resume after sign-in. Resuming
 *     re-runs OAuth from scratch, so nothing in that cookie is trusted for
 *     authorization.
 *   - A pure decision function that maps (session, verified state, accounts
 *     already linked to the shop) to an outcome. Account linking requires an
 *     authenticated session; there is no email-based or state-based linking.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_STATE_COOKIE = "shopify_oauth_state";
export const PENDING_INSTALL_COOKIE = "shopify_pending_install";

/** OAuth round-trip window (authorize screen + redirect back). */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
/** How long a merchant has to sign in / sign up before the install must restart. */
export const PENDING_INSTALL_TTL_SECONDS = 30 * 60;
/** Accept Shopify callback timestamps up to this old (seconds)… */
const CALLBACK_MAX_AGE_SECONDS = 15 * 60;
/** …and tolerate this much clock skew into the future. */
const CALLBACK_MAX_FUTURE_SKEW_SECONDS = 5 * 60;

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const OAUTH_FROM_VALUES = [
  "login",
  "signup",
  "app_store",
  "onboarding",
  "dashboard",
  "pricing",
] as const;
export type OAuthFrom = (typeof OAUTH_FROM_VALUES)[number];

export const PLAN_VALUES = ["free", "starter", "growth", "scale"] as const;
export type SelectedPlan = (typeof PLAN_VALUES)[number] | "";

export interface OAuthStatePayload {
  /** Random nonce; equals the `state` query parameter sent to Shopify. */
  n: string;
  shop: string;
  from: OAuthFrom;
  plan: SelectedPlan;
  /** Clerk user who started the flow, or null when started signed-out. */
  uid: string | null;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export interface PendingInstallPayload {
  shop: string;
  from: OAuthFrom;
  plan: SelectedPlan;
  exp: number;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function isValidShopDomain(shop: unknown): shop is string {
  return typeof shop === "string" && shop.length <= 255 && SHOP_DOMAIN_RE.test(shop);
}

export function normalizeFrom(value: string | null | undefined, signedIn: boolean): OAuthFrom {
  const v = (value || "").trim().toLowerCase();
  if ((OAUTH_FROM_VALUES as readonly string[]).includes(v)) return v as OAuthFrom;
  return signedIn ? "onboarding" : "signup";
}

export function normalizePlan(value: string | null | undefined): SelectedPlan {
  const v = (value || "").trim().toLowerCase();
  return (PLAN_VALUES as readonly string[]).includes(v) ? (v as SelectedPlan) : "";
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the `hmac` query parameter Shopify adds to OAuth redirects: HMAC-SHA256
 * (hex) over the remaining parameters sorted by key and joined as `k=v&k=v`.
 */
export function verifyShopifyQueryHmac(searchParams: URLSearchParams, secret: string | undefined): boolean {
  if (!secret) return false;
  const provided = searchParams.get("hmac");
  if (!provided || !/^[0-9a-f]{64}$/i.test(provided)) return false;

  const message = [...searchParams.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const computed = createHmac("sha256", secret).update(message).digest("hex");
  return safeEqual(computed, provided.toLowerCase());
}

/** Shopify's `timestamp` parameter (epoch seconds) must be recent. */
export function isFreshShopifyTimestamp(timestamp: string | null, nowMs = Date.now()): boolean {
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return false;
  const ageSeconds = nowMs / 1000 - Number(timestamp);
  return ageSeconds <= CALLBACK_MAX_AGE_SECONDS && ageSeconds >= -CALLBACK_MAX_FUTURE_SKEW_SECONDS;
}

// ── Signed cookies ───────────────────────────────────────────────────────────

function cookieKey(purpose: string): Buffer {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) throw new Error("SHOPIFY_CLIENT_SECRET is not configured");
  // Domain-separated subkey: never reuse the raw client secret for cookie MACs.
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `omnitarget/${purpose}/v1`, 32));
}

function sign(payload: object, purpose: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", cookieKey(purpose)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token: string | null | undefined, purpose: string): Record<string, unknown> | null {
  if (!token || typeof token !== "string" || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected: string;
  try {
    expected = createHmac("sha256", cookieKey(purpose)).update(body).digest("base64url");
  } catch {
    return null;
  }
  if (!safeEqual(mac, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createOAuthState(
  input: { shop: string; from: OAuthFrom; plan: SelectedPlan; initiatorUserId: string | null },
  nowMs = Date.now(),
): { nonce: string; cookieValue: string } {
  if (!isValidShopDomain(input.shop)) throw new Error("Invalid shop domain for OAuth state");
  const nonce = randomBytes(32).toString("hex");
  const payload: OAuthStatePayload = {
    n: nonce,
    shop: input.shop,
    from: input.from,
    plan: input.plan,
    uid: input.initiatorUserId,
    exp: nowMs + OAUTH_STATE_TTL_SECONDS * 1000,
  };
  return { nonce, cookieValue: sign(payload, "shopify-oauth-state") };
}

export function readOAuthState(cookieValue: string | null | undefined, nowMs = Date.now()): OAuthStatePayload | null {
  const p = verify(cookieValue, "shopify-oauth-state");
  if (!p) return null;
  if (typeof p.n !== "string" || !/^[0-9a-f]{64}$/.test(p.n)) return null;
  if (!isValidShopDomain(p.shop)) return null;
  if (typeof p.exp !== "number" || p.exp <= nowMs) return null;
  if (p.uid !== null && typeof p.uid !== "string") return null;
  return {
    n: p.n,
    shop: p.shop,
    from: normalizeFrom(p.from as string, Boolean(p.uid)),
    plan: normalizePlan(p.plan as string),
    uid: (p.uid as string | null) ?? null,
    exp: p.exp,
  };
}

export function createPendingInstall(
  input: { shop: string; from: OAuthFrom; plan: SelectedPlan },
  nowMs = Date.now(),
): string {
  if (!isValidShopDomain(input.shop)) throw new Error("Invalid shop domain for pending install");
  const payload: PendingInstallPayload = {
    shop: input.shop,
    from: input.from,
    plan: input.plan,
    exp: nowMs + PENDING_INSTALL_TTL_SECONDS * 1000,
  };
  return sign(payload, "shopify-pending-install");
}

export function readPendingInstall(
  cookieValue: string | null | undefined,
  nowMs = Date.now(),
): PendingInstallPayload | null {
  const p = verify(cookieValue, "shopify-pending-install");
  if (!p) return null;
  if (!isValidShopDomain(p.shop)) return null;
  if (typeof p.exp !== "number" || p.exp <= nowMs) return null;
  return {
    shop: p.shop,
    from: normalizeFrom(p.from as string, false),
    plan: normalizePlan(p.plan as string),
    exp: p.exp,
  };
}

// ── Cookie helpers (Route Handlers return raw Responses) ─────────────────────

export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function serializeCookie(name: string, value: string, maxAgeSeconds: number, httpOnly = true): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "Path=/",
    "SameSite=Lax",
    "Secure",
    httpOnly ? "HttpOnly" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookie(name: string): string {
  return serializeCookie(name, "", 0);
}

// ── Callback decision ────────────────────────────────────────────────────────

export type CallbackDecision =
  | { kind: "reject"; reason: "invalid_state" | "session_mismatch" }
  | { kind: "link_to_session"; userId: string }
  | { kind: "sign_in_linked_user"; userId: string }
  | { kind: "pending_install"; reason: "no_linked_account" | "ambiguous_linked_accounts" };

/**
 * Decide what a *verified* callback (HMAC, host and timestamp already checked)
 * may do. The only inputs that can select an account are the browser's own
 * Clerk session and accounts already linked to this exact shop. In particular
 * the callback `state` value and the shop's contact email never select one.
 */
export function resolveCallbackDecision(input: {
  sessionUserId: string | null;
  statePayload: OAuthStatePayload | null;
  stateParam: string;
  shop: string;
  linkedUserIds: string[];
}): CallbackDecision {
  const { sessionUserId, statePayload, stateParam, shop, linkedUserIds } = input;

  if (!statePayload || !stateParam || !safeEqual(stateParam, statePayload.n) || statePayload.shop !== shop) {
    return { kind: "reject", reason: "invalid_state" };
  }

  // A flow started by one account must finish in that same account's session.
  if (statePayload.uid && statePayload.uid !== sessionUserId) {
    return { kind: "reject", reason: "session_mismatch" };
  }

  if (sessionUserId) return { kind: "link_to_session", userId: sessionUserId };

  const distinct = [...new Set(linkedUserIds.filter(Boolean))];
  if (distinct.length === 1) return { kind: "sign_in_linked_user", userId: distinct[0] };
  if (distinct.length > 1) return { kind: "pending_install", reason: "ambiguous_linked_accounts" };
  return { kind: "pending_install", reason: "no_linked_account" };
}
