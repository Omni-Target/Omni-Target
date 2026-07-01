import { z } from "zod";

/**
 * Centralized, validated access to environment variables.
 *
 * Validation is lazy (runs on first access, not at import/build time) so it
 * never breaks the build, and only throws a clear, actionable error at runtime
 * when a genuinely required variable is missing or malformed.
 *
 * Only variables that are always required (app URL + Supabase) are validated as
 * required here. Provider-specific secrets are optional in the schema and should
 * be read at their point of use via `requireEnv(...)` so an unrelated route
 * never fails because of an unset secret it doesn't use.
 */
const EnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Provider-specific secrets — optional here, asserted at point of use.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional(),
  R2_PUBLIC_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Returns the validated environment. Throws a single, clear error listing every
 * invalid/missing required variable. Result is memoized after the first call.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(
      `[env] Invalid or missing environment variables: ${fields}`
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Read an environment variable that must be present, throwing a clear error if
 * it is absent. Use for provider secrets at their point of use.
 */
export function requireEnv(key: keyof Env): string {
  const value = getEnv()[key];
  if (!value) {
    throw new Error(`[env] Missing required environment variable: ${key}`);
  }
  return value;
}
