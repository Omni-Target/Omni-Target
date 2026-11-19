import "server-only";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { shopAccessCheck } from "@/trigger/shop-access";
import type { shopImport } from "@/trigger/shop-import";
import { markImportDispatched, requestImport } from "@/modules/ingestion/imports";
import { createLogger } from "@/platform/logger";
import { requireEnv } from "@/platform/env";
import type { ShopAccessCheckPayload } from "./payloads";

const log = createLogger({ module: "jobs" });

/** Triggering must never hold up the request that asked for it. */
export const TRIGGER_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("trigger_timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Queues a shop access check. The idempotency key folds repeated triggers for
 * the same shop and reason within an hour into one run (a retried OAuth
 * callback, a double click); the concurrency key keeps one run per shop.
 * Returns the run id, or null when it could not be queued (logged, never thrown).
 */
export async function enqueueShopAccessCheck(payload: ShopAccessCheckPayload): Promise<string | null> {
  try {
    requireEnv(["TRIGGER_SECRET_KEY"] as const);
    const idempotencyKey = await idempotencyKeys.create(`shop-access-check:${payload.shopDomain}:${payload.reason}`, { scope: "global" });
    const handle = await withTimeout(
      tasks.trigger<typeof shopAccessCheck>("shop-access-check", payload, {
        idempotencyKey,
        idempotencyKeyTTL: "1h",
        concurrencyKey: payload.shopDomain,
        tags: [`shop:${payload.shopDomain}`, `reason:${payload.reason}`],
      }),
      TRIGGER_TIMEOUT_MS,
    );
    log.info("Shop access check queued", { shop: payload.shopDomain, reason: payload.reason, runId: handle.id });
    return handle.id;
  } catch (error) {
    log.warn("Shop access check not queued", { shop: payload.shopDomain, reason: payload.reason }, error);
    return null;
  }
}

/**
 * Dispatches an import run. The idempotency key includes the attempt, so a
 * re-dispatch by the reconcile job starts a new run instead of returning the
 * one that died; the import record decides which run may work. Returns the
 * run id, or null if Trigger.dev could not be reached (the import stays
 * requested and the reconcile job dispatches it later).
 */
export async function dispatchShopImport(importId: string, shopDomain: string, attempt: number): Promise<string | null> {
  try {
    requireEnv(["TRIGGER_SECRET_KEY"] as const);
    const idempotencyKey = await idempotencyKeys.create(`shop-import:${importId}:${attempt}`, { scope: "global" });
    const handle = await withTimeout(
      tasks.trigger<typeof shopImport>("shop-import", { importId, shopDomain }, {
        idempotencyKey, idempotencyKeyTTL: "1h", concurrencyKey: shopDomain, tags: [`shop:${shopDomain}`, "import:initial"],
      }),
      TRIGGER_TIMEOUT_MS,
    );
    await markImportDispatched(importId, handle.id);
    log.info("Shop import dispatched", { shop: shopDomain, importId, attempt, runId: handle.id });
    return handle.id;
  } catch (error) {
    log.warn("Shop import not dispatched; the reconcile job will retry", { shop: shopDomain, importId, attempt }, error);
    return null;
  }
}

/** Records the import first, then dispatches it: a failed dispatch is never lost. */
export async function requestShopImport(shopKey: number, shopDomain: string): Promise<{ importId: string | null; runId: string | null; outcome: string }> {
  const requested = await requestImport(shopKey);
  if (!requested.import_id) return { importId: null, runId: null, outcome: requested.outcome };
  if (requested.outcome === "existing" && requested.status !== "requested") return { importId: requested.import_id, runId: null, outcome: "already_running" };
  const runId = await dispatchShopImport(requested.import_id, shopDomain, (requested.dispatch_attempts ?? 0) + 1);
  return { importId: requested.import_id, runId, outcome: requested.outcome };
}

/** For callers holding only the shop's domain (the OAuth callback). Never throws. */
export async function requestShopImportForDomain(shopDomain: string): Promise<{ importId: string | null; runId: string | null; outcome: string }> {
  try {
    const { shopKeyFor } = await import("@/modules/ingestion/repository");
    const shopKey = await shopKeyFor(shopDomain);
    if (shopKey === null) return { importId: null, runId: null, outcome: "unknown_shop" };
    return await requestShopImport(shopKey, shopDomain);
  } catch (error) {
    log.warn("Shop import not requested", { shop: shopDomain }, error);
    return { importId: null, runId: null, outcome: "error" };
  }
}
