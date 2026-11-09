/**
 * Removes secrets and personal data from everything sent to Sentry (OPS-02).
 *
 * Runs in the browser, server and edge SDKs as the last step before an event
 * leaves the process. Sensitive fields are filtered by key, and free text
 * (error messages, breadcrumbs, span descriptions) by pattern, because
 * third-party errors often embed a token or email in the message itself.
 */
const FILTERED = "[Filtered]";
const MAX_DEPTH = 12;

/** Stack traces and SDK metadata hold no user data and must stay readable. */
const SKIP_KEYS = new Set(["stacktrace", "debug_meta", "sdk", "modules"]);

const SENSITIVE_KEY =
  /(token|secret|password|passwd|authorization|api[_-]?key|access[_-]?key|cookie|credential|signature|hmac|e?mail|phone|address|street|postal|zip|first_?name|last_?name|full_?name|customer)/i;

/** AI usage counters such as `gen_ai.usage.input_tokens` are not secrets. */
const isTokenCount = (key: string, value: unknown) => typeof value === "number" && /tokens/i.test(key);

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${FILTERED}@`], // user:password@host
  [/(https?:\/\/[^\s?#"']+)\?[^\s"'#]*/gi, `$1?${FILTERED}`], // OAuth codes, shop params
  [/\bshp(?:at|ua|ss|ca|pa|rt)_[A-Za-z0-9_-]+/g, FILTERED], // Shopify
  [/\bEAA[A-Za-z0-9]{20,}/g, FILTERED], // Meta
  [/\bsk-ant-[A-Za-z0-9_-]+/g, FILTERED], // Anthropic
  [/\b(?:sk|rk|whsec)_(?:live_|test_)?[A-Za-z0-9]{16,}/g, FILTERED], // Stripe, Clerk
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, FILTERED], // Supabase
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, FILTERED], // JWT
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${FILTERED}`],
  [/\b(access_token|refresh_token|client_secret|password)=[^&\s"']+/gi, `$1=${FILTERED}`],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, FILTERED], // email
  [/(?<![\w.])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\w)/g, FILTERED], // +234 801 234 5678
  [/\(\d{3}\)\s?\d{3}[\s.-]\d{4}\b/g, FILTERED], // (555) 123-4567
  [/\b0[789][01]\d{8}\b/g, FILTERED], // Nigerian local mobile
];

export function scrubText(text: string): string {
  return TEXT_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SKIP_KEYS.has(key)) result[key] = item;
    else if (SENSITIVE_KEY.test(key) && !isTokenCount(key, item)) result[key] = FILTERED;
    else result[key] = scrubValue(item, depth + 1);
  }
  return result;
}

/** Returns a filtered copy of a Sentry event, transaction or breadcrumb. */
export function scrubSentryEvent<T extends object>(event: T): T {
  const scrubbed = scrubValue(event, 0) as T & { user?: unknown };
  // Identity is off (dataCollection.userInfo); nothing may reintroduce it.
  delete scrubbed.user;
  return scrubbed;
}
