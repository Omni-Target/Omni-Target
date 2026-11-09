import type { ConnectOutcome } from "./repository";

/**
 * Shopify installation under a per-shop lease (Phase 1, task 3.1).
 *
 * Exchanging an OAuth code retires the shop's earlier offline tokens, so the
 * exchange is only ever reached by an account allowed to own the shop:
 *
 *   1. take the shop's install lease (keyed by the Shopify-verified domain);
 *   2. decide ownership, or an approved transfer, while holding it;
 *   3. exchange the code and read Shopify's immutable shop id;
 *   4. commit the binding in a transaction that proves the lease is still ours;
 *   5. store the credential, then release the lease.
 *
 * Another callback for the same shop waits for the lease and then sees the
 * committed owner. A callback whose lease expired and was taken over commits
 * nothing. No database transaction stays open across a Shopify request.
 *
 * Pure orchestration: the database and Shopify are injected, so the same code
 * runs against real Postgres in tests.
 */

export const INSTALL_LEASE_SECONDS = 60;

export interface ExchangedToken {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
}

export interface ShopIdentity {
  id: number;
  myshopifyDomain: string;
  name: string | null;
  details: Record<string, unknown>;
}

export type LeaseCheckOutcome = ConnectOutcome | "rejected_lease_lost" | "rejected_transfer_not_ready";

export interface InstallRequest {
  shop: string;
  code: string;
  actor: string;
  selectedWorkspaceId: string | null;
  transferId: string | null;
}

export interface CommitInput {
  shop: string;
  holder: string;
  actor: string;
  identity: ShopIdentity;
  token: ExchangedToken;
  selectedWorkspaceId: string | null;
  transferId: string | null;
}

export interface CommitResult {
  outcome: string;
  workspace_id?: string;
  previous_workspace_id?: string;
}

export interface InstallPorts {
  acquireLease(shop: string, actor: string): Promise<string | null>;
  releaseLease(shop: string, holder: string): Promise<void>;
  leaseHeld(shop: string, holder: string): Promise<boolean>;
  check(shop: string, holder: string, actor: string, transferId: string | null): Promise<LeaseCheckOutcome>;
  exchangeCode(shop: string, code: string): Promise<ExchangedToken>;
  fetchShop(shop: string, accessToken: string): Promise<ShopIdentity>;
  commit(input: CommitInput): Promise<CommitResult>;
  /** Stores the credential after a successful commit, while the lease is still held. */
  persist(input: CommitInput & { result: CommitResult }): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type InstallResult =
  | { kind: "busy" }
  | { kind: "refused"; outcome: string; exchanged: boolean }
  | { kind: "lease_lost"; exchanged: boolean }
  | { kind: "connected"; result: CommitResult; identity: ShopIdentity; token: ExchangedToken };

export interface InstallOptions {
  /** Attempts to take a busy lease before giving up. */
  attempts: number;
  pollMs: number;
}

const DEFAULTS: InstallOptions = { attempts: 20, pollMs: 500 };

export async function installUnderLease(
  request: InstallRequest,
  ports: InstallPorts,
  options: InstallOptions = DEFAULTS,
): Promise<InstallResult> {
  let holder: string | null = null;
  for (let attempt = 0; attempt < options.attempts && !holder; attempt++) {
    if (attempt > 0) await ports.sleep(options.pollMs);
    holder = await ports.acquireLease(request.shop, request.actor);
  }
  if (!holder) return { kind: "busy" };

  try {
    const check = await ports.check(request.shop, holder, request.actor, request.transferId);
    if (check === "rejected_lease_lost") return { kind: "lease_lost", exchanged: false };
    if (check !== "allowed") return { kind: "refused", outcome: check, exchanged: false };

    const token = await ports.exchangeCode(request.shop, request.code);
    const identity = await ports.fetchShop(request.shop, token.accessToken);
    const input: CommitInput = {
      shop: request.shop,
      holder,
      actor: request.actor,
      identity,
      token,
      selectedWorkspaceId: request.selectedWorkspaceId,
      transferId: request.transferId,
    };

    const result = await ports.commit(input);
    if (result.outcome === "rejected_lease_lost") return { kind: "lease_lost", exchanged: true };
    if (result.outcome.startsWith("rejected_")) return { kind: "refused", outcome: result.outcome, exchanged: true };

    // A callback that stalled past its lease after committing must not
    // overwrite a credential stored by the callback that took the lease over.
    if (!(await ports.leaseHeld(request.shop, holder))) return { kind: "lease_lost", exchanged: true };
    await ports.persist({ ...input, result });
    return { kind: "connected", result, identity, token };
  } finally {
    await ports.releaseLease(request.shop, holder).catch(() => undefined);
  }
}
