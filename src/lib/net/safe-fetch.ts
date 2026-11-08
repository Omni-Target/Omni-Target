/**
 * SSRF-safe HTTPS fetch for merchant-supplied hostnames (Phase S0.5 — SEC-07).
 *
 * Used where the server must contact arbitrary public hosts named by a user
 * or by Shopify data (custom-domain resolution, storefront logo discovery).
 * Guarantees:
 *   - https only, default port only, no credentials in the URL, no IP literals;
 *   - every connection's DNS answers are checked at socket-lookup time and
 *     the request is refused if ANY resolved address is non-public (loopback,
 *     private, link-local/cloud-metadata, CGNAT, multicast, reserved, IPv6
 *     ULA/link-local, NAT64/6to4/Teredo…). Because the check happens in the
 *     connection's own lookup there is no resolve-then-connect gap for DNS
 *     rebinding to exploit;
 *   - redirects are followed manually (bounded) and each hop is re-validated;
 *   - an overall deadline and a response-size cap.
 * Errors carry a coarse `code` only, so callers can show one generic message
 * and the endpoint does not become an oracle for internal reachability.
 */
import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import https from "node:https";
import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_destination"
  | "timeout"
  | "too_many_redirects"
  | "network";

export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Overall deadline across all redirect hops. */
  timeoutMs?: number;
  /** Response bytes kept; beyond this the body is truncated and the socket closed. */
  maxBytes?: number;
  /** 0 returns the first 3xx response as-is. */
  maxRedirects?: number;
}

export interface SafeFetchResponse {
  status: number;
  /** Lower-cased header names; multi-value headers joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  /** URL of the final hop. */
  url: string;
}

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
// NOTE: no rule for IPv4-mapped space (::ffff:0:0/96) — Node's BlockList treats
// IPv4 addresses as IPv4-mapped IPv6, so such a rule would block ALL IPv4.
// Mapped addresses are unwrapped in isPublicIpAddress and checked as IPv4.
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback, deprecated IPv4-compatible
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** Expand an IPv6 address (incl. "::" and an embedded IPv4 tail) to 8 hextets. */
function ipv6Hextets(address: string): number[] | null {
  let addr = address.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  const v4Tail = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const parts = v4Tail[1].split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    addr =
      addr.slice(0, -v4Tail[1].length) +
      `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const all = [...head, ...new Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.length !== 8) return null;
  const nums = all.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** True only for globally routable unicast addresses. */
export function isPublicIpAddress(address: string): boolean {
  if (isIPv4(address)) return !NON_PUBLIC.check(address, "ipv4");
  if (isIPv6(address)) {
    const h = ipv6Hextets(address);
    if (!h) return false;
    // IPv4-mapped (::ffff:a.b.c.d, dotted or hex form): judge the embedded IPv4.
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
      return isPublicIpAddress(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
    }
    return !NON_PUBLIC.check(address, "ipv6");
  }
  return false;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
type Resolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for net/https that refuses hostnames resolving to any
 * non-public address. Exported (with an injectable resolver) for tests.
 */
export function createSafeLookup(resolve: Resolver = dns.lookup as unknown as Resolver) {
  return (hostname: string, options: LookupOptions | number | undefined, callback: LookupCallback): void => {
    const opts: LookupOptions = typeof options === "number" ? { family: options } : options || {};
    resolve(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      if (!addresses?.length || addresses.some((a) => !isPublicIpAddress(a.address))) {
        const blocked = new Error(`Destination ${hostname} resolves to a non-public address`) as NodeJS.ErrnoException;
        blocked.code = "EBLOCKED";
        return callback(blocked, "", 4);
      }
      // Prefer IPv4: many hosts (and serverless regions) lack IPv6 routes, and
      // Node's happy-eyeballs tries addresses sequentially.
      const ordered = [...addresses].sort((a, b) => (a.family === b.family ? 0 : a.family === 4 ? -1 : 1));
      if (opts.all) return callback(null, ordered);
      return callback(null, ordered[0].address, ordered[0].family);
    });
  };
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Parse and validate a URL the server is allowed to contact. */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url", "Invalid URL");
  }
  if (url.protocol !== "https:") throw new SafeFetchError("invalid_url", "Only https is allowed");
  if (url.port && url.port !== "443") throw new SafeFetchError("invalid_url", "Non-default port");
  if (url.username || url.password) throw new SafeFetchError("invalid_url", "Credentials in URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) throw new SafeFetchError("blocked_destination", "IP literal hosts are not allowed");
  if (!HOSTNAME_RE.test(host)) throw new SafeFetchError("invalid_url", "Invalid hostname");
  return url;
}

const safeLookup = createSafeLookup();

/** Shopify's edge rejects requests without a browser-like User-Agent. */
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; OmniTarget/1.0; +https://omnitarget.co)";

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  deadline: number,
  maxBytes: number,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new SafeFetchError("timeout", "Request timed out"));

    const requestHeaders: Record<string, string> = { "user-agent": DEFAULT_USER_AGENT, ...headers };
    if (body) requestHeaders["content-length"] = String(Buffer.byteLength(body));
    const req = https.request(
      url,
      {
        method,
        headers: requestHeaders,
        lookup: safeLookup as unknown as https.RequestOptions["lookup"],
        agent: false,
        // Give each address a fair chance before falling back to the next
        // family (Node's default per-attempt timeout is very short).
        autoSelectFamilyAttemptTimeout: 2000,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        const finish = () =>
          resolve({
            status: res.statusCode || 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v ?? ""]),
            ),
            body: Buffer.concat(chunks),
            truncated,
          });
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          if (bytes + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, Math.max(0, maxBytes - bytes)));
            bytes = maxBytes;
            truncated = true;
            finish();
            req.destroy();
            return;
          }
          chunks.push(chunk);
          bytes += chunk.length;
        });
        res.on("end", () => {
          if (!truncated) finish();
        });
        res.on("error", (err) => {
          if (!truncated) reject(new SafeFetchError("network", err.message));
        });
      },
    );

    const timer = setTimeout(() => req.destroy(new SafeFetchError("timeout", "Request timed out")), remaining);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err instanceof SafeFetchError) return reject(err);
      if (err.code === "EBLOCKED") return reject(new SafeFetchError("blocked_destination", err.message));
      reject(new SafeFetchError("network", err.code || err.message));
    });
    if (body) req.write(body);
    req.end();
  });
}

export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const deadline = Date.now() + (options.timeoutMs ?? 6_000);
  let method = options.method ?? "GET";
  let body = options.body;
  let url = assertSafeUrl(raw);

  for (let hop = 0; ; hop += 1) {
    const res = await requestOnce(url, method, options.headers ?? {}, body, deadline, maxBytes);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location && maxRedirects > 0) {
      if (hop >= maxRedirects) throw new SafeFetchError("too_many_redirects", "Too many redirects");
      url = assertSafeUrl(new URL(location, url).toString());
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return { ...res, url: url.toString() };
  }
}
