import type { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db";
import { apiError } from "./response";

export interface RateLimitConfig {
  /** Stable identifier for the limited action, e.g. "campaigns:generate". */
  action: string;
  /** Identity to scope by — typically the Clerk userId. */
  identifier: string;
  /** Max allowed requests within the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * Atomic, Supabase-backed fixed-window rate limit, mirroring the
 * {@link import("./require-user").requireUser} result shape:
 *
 *   const limited = await enforceRateLimit({ ... });
 *   if (!limited.ok) return limited.response;
 *
 * Fails OPEN (allows the request) if the backing `check_rate_limit` RPC is
 * missing or errors — it logs a warning instead — so a not-yet-applied
 * migration (0002_rate_limits.sql) never takes a route down.
 */
export async function enforceRateLimit(
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const key = `${config.action}:${config.identifier}`;
  try {
    const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
      p_key: key,
      p_limit: config.limit,
      p_window_seconds: config.windowSeconds,
    });

    if (error) {
      console.warn(
        `[rate-limit] RPC unavailable for ${key}; allowing request:`,
        error.message,
      );
      return { ok: true };
    }

    if (data === false) {
      return {
        ok: false,
        response: apiError(
          "You're doing that too often. Please wait a moment and try again.",
          429,
          "rate_limited",
        ),
      };
    }

    return { ok: true };
  } catch (err) {
    console.warn(`[rate-limit] error for ${key}; allowing request:`, err);
    return { ok: true };
  }
}
