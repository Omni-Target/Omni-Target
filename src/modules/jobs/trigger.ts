import "server-only";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { shopAccessCheck } from "@/trigger/shop-access";
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
