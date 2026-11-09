import { createHash } from "node:crypto";
import type { BindOutcome, ConnectOutcome, UninstallResult } from "./repository";

/**
 * Pure helpers for Shopify lifecycle webhooks and connection outcomes
 * (Phase 1, task 3). No I/O, so they are unit-tested directly.
 */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Shopify's numeric shop id from a payload, or null when absent or malformed. */
export function parseShopifyShopId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** X-Shopify-Triggered-At as an ISO timestamp, or null. */
export function parseTriggeredAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * The shop a webhook concerns. The body is covered by Shopify's HMAC and the
 * headers are not, so the domain named in the body wins.
 */
export function webhookShopDomain(payload: unknown, header: string | null | undefined): string | null {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  for (const candidate of [body.shop_domain, body.myshopify_domain, header]) {
    if (typeof candidate !== "string") continue;
    const domain = candidate.trim().toLowerCase();
    if (SHOP_DOMAIN.test(domain)) return domain;
  }
  return null;
}

/** Delivery identity: Shopify's webhook id, or a stable key derived from the signed body. */
export function lifecycleEventKey(input: { webhookId: string | null | undefined; topic: string; domain: string; rawBody: string }): string {
  const webhookId = input.webhookId?.trim();
  if (webhookId) return webhookId;
  const digest = createHash("sha256").update(input.rawBody).digest("hex").slice(0, 32);
  return `${input.topic}:${input.domain}:${digest}`;
}

/**
 * Whether this uninstall must clear the shop's stored credentials. Only an
 * uninstall that Shopify triggered before the merchant's latest reconnection
 * leaves them alone: those credentials belong to the newer installation.
 */
export function uninstallClearsCredentials(result: UninstallResult): boolean {
  const outcome = result.outcome === "duplicate" ? result.recorded_outcome : result.outcome;
  return outcome !== "stale";
}

const REFUSALS: Partial<Record<ConnectOutcome | BindOutcome, string>> = {
  rejected_other_owner:
    "This Shopify store is already connected to another Omnitarget account. Its owner can approve a transfer to you.",
  rejected_deletion_in_progress:
    "This store's data is being deleted at Shopify's request. You can connect it again once that finishes.",
  rejected_legacy_claim_under_review:
    "More than one Omnitarget account claims this store, so we are reviewing who owns it. Please contact support.",
  rejected_legacy_claim: "This store belongs to another Omnitarget account. Please sign in with that account.",
  rejected_workspace_ineligible: "That workspace cannot take this store. Choose another workspace or start a new one.",
  rejected_identity_conflict: "We could not confirm this store's identity with Shopify. Please contact support.",
};

/** What the merchant is told when a connection is refused. */
export function connectionRefusalMessage(outcome: ConnectOutcome | BindOutcome): string {
  return REFUSALS[outcome] ?? "We could not verify this Shopify store. Please try again.";
}

export function isRefusal(outcome: ConnectOutcome | BindOutcome): boolean {
  return outcome.startsWith("rejected_");
}
