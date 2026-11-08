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
  /**
   * What to do when the limiter itself is unavailable (RPC missing or
   * erroring). "allow" (default) keeps authenticated routes up; public,
   * unauthenticated routes that trigger outbound requests should pass "deny"
   * so a database outage never removes their only abuse control.
   */
  onUnavailable?: "allow" | "deny";
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
 * By default fails OPEN (allows the request, logs a warning) if the backing
 * `check_rate_limit` RPC is missing or errors, so a limiter outage never takes
 * an authenticated route down. Public routes pass `onUnavailable: "deny"` to
 * fail CLOSED with a 503 instead (SEC-07/SEC-13).
 */
export async function enforceRateLimit(
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const key = `${config.action}:${config.identifier}`;
  const unavailable = (detail: unknown): RateLimitResult => {
    if (config.onUnavailable === "deny") {
      console.warn(`[rate-limit] limiter unavailable for ${config.action}; denying request:`, detail);
      return {
        ok: false,
        response: apiError(
          "This check is temporarily unavailable. Please try again shortly.",
          503,
          "rate_limit_unavailable",
        ),
      };
    }
    console.warn(`[rate-limit] limiter unavailable for ${key}; allowing request:`, detail);
    return { ok: true };
  };
  try {
    const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
      p_key: key,
      p_limit: config.limit,
      p_window_seconds: config.windowSeconds,
    });

    if (error) return unavailable(error.message);

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
    return unavailable(err);
  }
}
