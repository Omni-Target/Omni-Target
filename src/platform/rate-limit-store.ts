import "server-only";
import { supabaseAdmin } from "@/platform/supabase";

/**
 * Counts one request in a fixed window (check_rate_limit). Returns false when
 * the limit is reached; throws when the limiter cannot be reached, so the
 * caller decides whether to fail open or closed.
 */
export async function consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error(error.message);
  return data !== false;
}
