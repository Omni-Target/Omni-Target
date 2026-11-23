import { createHmac } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import type { ImportDeps } from "../workflow";
import { fakeGql } from "./fake-shopify";

/**
 * The scale verification's harness (Phase 2, task 12). Runs the real import
 * workflow against a LOCAL Supabase database (Postgres behind PostgREST, with
 * Supabase's 8 s statement timeout and 1,000-row limit) and a fake Shopify.
 * Never touches staging or production: it refuses any database that is not
 * on this machine. Opt-in checks only.
 */
const pg = createRequire(import.meta.url)("pg") as typeof import("pg");

export function requireLocal(url: string | undefined, name: string): string {
  if (!url || !/^(postgres(ql)?|http):\/\/[^@/]*@?(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`${name} must point at this machine`);
  return url;
}

/**
 * A service-role token for the local PostgREST, signed HS256 with its secret: a plain string, or the
 * symmetric ("oct") key of a JSON Web Key set, as newer Supabase stacks configure it.
 */
export function serviceToken(secret: string): string {
  let key: Buffer | string = secret;
  let kid: string | undefined;
  if (secret.trim().startsWith("{")) {
    const oct = (JSON.parse(secret) as { keys?: Array<{ kty: string; k?: string; kid?: string }> }).keys?.find((k) => k.kty === "oct" && k.k);
    if (!oct?.k) throw new Error("the JWT key set has no symmetric key");
    key = Buffer.from(oct.k, "base64url");
    kid = oct.kid;
  }
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = { alg: "HS256", typ: "JWT", ...(kid ? { kid } : {}) };
  const body = `${b64(header)}.${b64({ role: "service_role", iss: "supabase", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86_400 })}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** Supabase serves PostgREST under /rest/v1; a direct PostgREST serves it at the root. */
export async function startRestProxy(target: string): Promise<{ url: string; stop(): Promise<void> }> {
  const upstream = new URL(target);
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\/rest\/v1/, "") || "/";
    const forward = httpRequest({ host: upstream.hostname, port: upstream.port, method: req.method, path, headers: { ...req.headers, host: upstream.host } }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    forward.on("error", (error) => { res.writeHead(502).end(error.message); });
    req.pipe(forward);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Times every database call the app makes (supabase-js fetches), by RPC or table. */
export function timeDatabaseCalls(): { stats: () => Record<string, { calls: number; p50: number; p95: number; max: number; over8s: number; failed: number }>; stop(): void } {
  const durations = new Map<string, number[]>();
  const failures = new Map<string, number>();
  const original = globalThis.fetch;
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /\/rest\/v1\/(rpc\/)?([a-z_0-9]+)/.exec(url);
    if (!match) return original(input, init);
    const name = match[1] ? match[2] : `table:${match[2]}`;
    const started = performance.now();
    try {
      const response = await original(input, init);
      if (!response.ok) failures.set(name, (failures.get(name) ?? 0) + 1);
      return response;
    } finally {
      durations.set(name, [...(durations.get(name) ?? []), performance.now() - started]);
    }
  };
  const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    stats: () => Object.fromEntries([...durations].map(([name, all]) => {
      const sorted = [...all].sort((a, b) => a - b);
      return [name, { calls: all.length, p50: Math.round(pct(sorted, 0.5)), p95: Math.round(pct(sorted, 0.95)), max: Math.round(sorted[sorted.length - 1]),
        over8s: all.filter((d) => d >= 8_000).length, failed: failures.get(name) ?? 0 }];
    })),
    stop: () => { globalThis.fetch = original; },
  };
}

export function database(url: string) {
  const pool = new pg.Pool({ connectionString: requireLocal(url, "SCALE_DB_URL"), max: 4 });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
  return { pool, q, end: () => pool.end() };
}
export type Database = ReturnType<typeof database>;

/** A bound shop and a requested import, as an install and the import request leave them. */
export async function shopWithImport(db: Database, label: string): Promise<{ shopKey: number; domain: string; importId: string }> {
  const domain = `scale-${label}-${Date.now().toString(36)}.myshopify.com`;
  const shopifyId = Math.floor(Math.random() * 9e12) + 1e12;
  await db.q("select public.bind_shop_for_install($1, $2, $3, null, 'Scale shop')", [shopifyId, domain, `user_${label}`]);
  const [{ shop_key: shopKey }] = await db.q<{ shop_key: number }>("select shop_key from public.shops where myshopify_domain = $1", [domain]);
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query("select public.request_shop_import($1) as r", [shopKey]);
    await client.query("commit");
    return { shopKey, domain, importId: rows[0].r.import_id };
  } finally {
    client.release();
  }
}

/** Rows and an order-independent checksum per table, without the columns that differ between runs. */
export const CHECKED_TABLES = [
  "products", "product_variants", "metafields", "inventory_locations", "inventory_levels", "customers", "orders", "order_line_items",
  "refunds", "returns", "return_line_items", "store_monthly_metrics", "product_monthly_metrics",
] as const;
const VOLATILE = ["shop_key", "synced_at", "computed_at", "finalized_at", "recorded_at", "import_id", "id"];
export async function tableChecksums(db: Database, shopKey: number): Promise<Record<string, { rows: number; sum: string }>> {
  const out: Record<string, { rows: number; sum: string }> = {};
  for (const table of CHECKED_TABLES) {
    const drop = VOLATILE.map((c) => `- '${c}'`).join(" ");
    const [row] = await db.q<{ rows: string; sum: string | null }>(
      `select count(*) as rows, sum(('x' || substr(md5((to_jsonb(t) ${drop})::text), 1, 15))::bit(60)::bigint)::text as sum from public.${table} t where shop_key = $1`, [shopKey]);
    out[table] = { rows: Number(row.rows), sum: row.sum ?? "0" };
  }
  return out;
}

/** The import's Shopify side: a fake session, the fake's GraphQL, and an access check granting every domain. */
export function fakeImportDeps(fakeUrl: string): ImportDeps {
  const available = { status: "available" as const, reasons: [] };
  return {
    access: (async () => ({ status: "ok", accessToken: "fake-token" })) as unknown as ImportDeps["access"],
    gql: () => fakeGql(fakeUrl),
    checkAccess: async () => ({
      outcome: "checked" as const,
      report: {
        grantedScopes: ["read_products", "read_orders", "read_all_orders", "read_customers", "read_inventory", "read_returns"],
        domains: {
          catalog: available, customers: available, inventory: available, returns: available, custom_data: available, settings: available,
          orders: { ...available, history: { from: null, basis: "retention_window" as const, missing_scope: null, oldest_reachable_order_at: null } },
        },
        withheldFields: {},
        shop: { currency: "GBP", timezone: "UTC" },
      },
    }),
  };
}
