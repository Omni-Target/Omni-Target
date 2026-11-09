import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "./env";

/**
 * The only Supabase client in the application. It uses the service role, which
 * bypasses row level security, so it must never reach browser code: the
 * `server-only` import makes such an import a build error. Tenant isolation is
 * enforced by the repositories that use it, not by RLS.
 */
let client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    const env = getServerEnv();
    client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * Lazy handle with the client's own interface, so existing `supabaseAdmin.from`
 * call sites keep working while the environment is validated on first use.
 */
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, property) {
    const real = getSupabaseAdmin();
    const value = Reflect.get(real, property, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
