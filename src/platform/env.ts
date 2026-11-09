import "server-only";
import { z } from "zod";

/**
 * Validated server environment (Phase 1, task 1). The data access layer reads
 * configuration through here instead of `process.env`, so a missing or
 * malformed value fails with a clear message naming the variable, never its
 * value. Validation is lazy: routes that do not need a value never fail on it.
 */
const coreSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ message: "must be a URL" }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, { message: "is required" }),
});

export type CoreEnv = z.infer<typeof coreSchema>;

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Server environment is not configured: ${problems.join("; ")}`);
    this.name = "EnvError";
  }
}

let cached: CoreEnv | null = null;

function describe(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => `${issue.path.join(".")} ${issue.message.includes("received undefined") ? "is required" : issue.message}`);
}

/** Core variables every server data path needs. Cached after the first success. */
export function getServerEnv(): CoreEnv {
  if (cached) return cached;
  const parsed = coreSchema.safeParse(process.env);
  if (!parsed.success) throw new EnvError(describe(parsed.error.issues));
  cached = parsed.data;
  return cached;
}

/** Feature-specific variables, validated when the feature first needs them. */
export function requireEnv<const K extends readonly string[]>(names: K): Record<K[number], string> {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new EnvError(missing.map((name) => `${name} is required`));
  return Object.fromEntries(names.map((name) => [name, process.env[name] as string])) as Record<K[number], string>;
}

/** Test hook: forget the cached result so a test can change the environment. */
export function resetServerEnvForTests(): void {
  cached = null;
}
