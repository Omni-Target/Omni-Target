/**
 * Read-only database & Shopify access inspection (Phase S0.1).
 *
 * Produces an aggregate report — RLS state, grants, exposure matrix, function
 * privileges, table/index sizes, JSON blob sizes, token/shop/credit integrity
 * counts and (optionally) live Shopify granted scopes.
 *
 * Safety guarantees (do not weaken these):
 *   - Every SQL statement runs inside `BEGIN TRANSACTION READ ONLY` with a
 *     statement timeout; the transaction is always rolled back.
 *   - Output contains aggregates only: no tokens, no row contents, no customer
 *     data. Shop domains are replaced by short hashes unless --show-shops.
 *   - The Shopify scope check uses stored access tokens that have NOT expired
 *     and never calls the token-refresh endpoint (refreshing rotates tokens,
 *     which is a write). Expired shops are reported as "not checked".
 *
 * Usage:
 *   node scripts/ops/db-inspect.mjs                     # reads .env.local
 *   node scripts/ops/db-inspect.mjs --env-file .env.production
 *   node scripts/ops/db-inspect.mjs --shopify-scopes --out report.json
 *
 * Connection string: SUPABASE_DB_URL | DATABASE_URL | POSTGRES_URL_NON_POOLING
 * | POSTGRES_URL (same precedence as supabase/migrate.mjs).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const SHOPIFY_API_VERSION = "2026-07";

/** Scopes required by the six mandatory ingestion data domains (plan §8.4). */
const REQUIRED_SCOPES = [
  "read_products",
  "read_inventory",
  "read_locations",
  "read_orders",
  "read_all_orders",
  "read_customers",
  "read_returns",
  "read_metaobjects",
  "read_metaobject_definitions",
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}

const envFile = option("--env-file") || ".env.local";
loadEnvFile(envFile);

const connectionString =
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL ||
  null;

if (!connectionString) {
  console.error(`No database connection string found (looked in ${envFile} and the environment).`);
  process.exit(1);
}

const hashLabel = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 10);

const human = (bytes) => {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
};

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

const targetLabel = (() => {
  try {
    const u = new URL(connectionString);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "(unparsable connection string)";
  }
})();

async function main() {
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const report = {
    generated_at: new Date().toISOString(),
    target: targetLabel,
    read_only: true,
  };
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");

    // ── Server & database size ──────────────────────────────────────────────
    const [meta] = await q(`
      select current_setting('server_version') as server_version,
             current_setting('server_version_num')::int as server_version_num,
             current_database() as database,
             pg_database_size(current_database())::bigint as db_bytes`);
    const quota = 500 * 1024 * 1024;
    report.server = {
      version: meta.server_version,
      version_num: meta.server_version_num,
      database: meta.database,
      db_bytes: Number(meta.db_bytes),
      db_human: human(meta.db_bytes),
      free_plan_quota_used_pct: Number(((Number(meta.db_bytes) / quota) * 100).toFixed(1)),
    };

    const roleRows = await q(
      `select rolname from pg_roles where rolname in ('anon','authenticated','service_role')`,
    );
    const roles = new Set(roleRows.map((r) => r.rolname));

    // ── Tables: RLS, sizes, grants, exposure ────────────────────────────────
    const tables = await q(`
      select c.oid, c.relname as table_name,
             c.relrowsecurity as rls_enabled,
             c.relforcerowsecurity as rls_forced,
             coalesce(s.n_live_tup, 0)::bigint as est_rows,
             pg_total_relation_size(c.oid)::bigint as total_bytes,
             pg_relation_size(c.oid)::bigint as heap_bytes,
             pg_indexes_size(c.oid)::bigint as index_bytes,
             coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)::bigint as toast_bytes
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_stat_user_tables s on s.relid = c.oid
       where n.nspname = 'public' and c.relkind in ('r', 'p')
       order by pg_total_relation_size(c.oid) desc`);

    const policies = await q(`
      select tablename, policyname, cmd, permissive, roles::text as roles
        from pg_policies where schemaname = 'public'`);

    const privCheck = async (role, oid) => {
      if (!roles.has(role)) return null;
      const [row] = await q(
        `select has_table_privilege($1, $2::oid, 'SELECT') as s,
                has_table_privilege($1, $2::oid, 'INSERT') as i,
                has_table_privilege($1, $2::oid, 'UPDATE') as u,
                has_table_privilege($1, $2::oid, 'DELETE') as d`,
        [role, oid],
      );
      const names = { s: "SELECT", i: "INSERT", u: "UPDATE", d: "DELETE" };
      return Object.keys(names).filter((k) => row[k]).map((k) => names[k]);
    };

    report.tables = [];
    for (const t of tables) {
      let exactRows = null;
      if (Number(t.est_rows) < 2_000_000) {
        const [c] = await q(`select count(*)::bigint as n from public.${ident(t.table_name)}`);
        exactRows = Number(c.n);
      }
      const anonPrivs = await privCheck("anon", t.oid);
      const authPrivs = await privCheck("authenticated", t.oid);
      const tablePolicies = policies.filter((p) => p.tablename === t.table_name);
      const exposedTo = [];
      if (!t.rls_enabled) {
        if (anonPrivs?.length) exposedTo.push(`anon:${anonPrivs.join("/")}`);
        if (authPrivs?.length) exposedTo.push(`authenticated:${authPrivs.join("/")}`);
      } else {
        for (const p of tablePolicies) {
          if (/anon|public|authenticated/i.test(p.roles)) {
            exposedTo.push(`policy:${p.policyname}(${p.cmd})->${p.roles}`);
          }
        }
      }
      report.tables.push({
        table: t.table_name,
        rows: exactRows ?? Number(t.est_rows),
        rows_exact: exactRows !== null,
        rls_enabled: t.rls_enabled,
        rls_forced: t.rls_forced,
        policies: tablePolicies.map((p) => `${p.policyname}:${p.cmd}:${p.roles}`),
        anon_privileges: anonPrivs,
        authenticated_privileges: authPrivs,
        exposed_via_data_api: exposedTo,
        total_bytes: Number(t.total_bytes),
        heap_bytes: Number(t.heap_bytes),
        index_bytes: Number(t.index_bytes),
        toast_bytes: Number(t.toast_bytes),
        total_human: human(t.total_bytes),
      });
    }
    report.exposure_summary = {
      roles_present: [...roles],
      tables_without_rls: report.tables.filter((t) => !t.rls_enabled).map((t) => t.table),
      tables_readable_by_anon_without_rls: report.tables
        .filter((t) => !t.rls_enabled && t.anon_privileges?.includes("SELECT"))
        .map((t) => t.table),
      tables_writable_by_anon_without_rls: report.tables
        .filter((t) => !t.rls_enabled && t.anon_privileges?.some((p) => p !== "SELECT"))
        .map((t) => t.table),
      tables_with_client_role_policies: report.tables
        .filter((t) => t.rls_enabled && t.exposed_via_data_api.length)
        .map((t) => t.table),
    };

    // ── Data API (PostgREST) role settings ──────────────────────────────────
    report.data_api_role_settings = (
      await q(`
        select r.rolname, s.setconfig
          from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
         where r.rolname in ('authenticator', 'anon', 'authenticated')`)
    ).map((r) => ({
      role: r.rolname,
      settings: (r.setconfig || []).filter((c) => /pgrst|search_path|statement_timeout/i.test(c)),
    }));

    // ── Functions: security definer + EXECUTE for client roles ──────────────
    const funcs = await q(`
      select p.oid, p.proname, p.prosecdef as security_definer,
             pg_get_function_identity_arguments(p.oid) as args,
             p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'`);
    report.functions = [];
    for (const f of funcs) {
      const exec = {};
      for (const role of ["anon", "authenticated"]) {
        if (!roles.has(role)) continue;
        const [r] = await q(`select has_function_privilege($1, $2::oid, 'EXECUTE') as x`, [role, f.oid]);
        exec[role] = r.x;
      }
      report.functions.push({
        name: `${f.proname}(${f.args})`,
        security_definer: f.security_definer,
        search_path_set: (f.proconfig || []).some((c) => c.startsWith("search_path=")),
        execute: exec,
      });
    }

    // ── Column inventory (drives conditional queries) ───────────────────────
    const cols = await q(`
      select table_name, column_name, data_type
        from information_schema.columns where table_schema = 'public'`);
    const has = (table, column) =>
      cols.some((c) => c.table_name === table && c.column_name === column);
    const typeOf = (table, column) =>
      cols.find((c) => c.table_name === table && c.column_name === column)?.data_type;

    // ── JSON blob sizes ─────────────────────────────────────────────────────
    const blob = async (table, column, expr = column) => {
      if (!has(table, column)) return null;
      const [r] = await q(`
        select count(*)::bigint as rows,
               count(${expr})::bigint as non_null,
               coalesce(max(pg_column_size(${expr})), 0)::bigint as max_bytes,
               coalesce(avg(pg_column_size(${expr})), 0)::bigint as avg_bytes,
               coalesce(sum(pg_column_size(${expr})), 0)::bigint as total_bytes
          from public.${ident(table)}`);
      return {
        rows: Number(r.rows),
        non_null: Number(r.non_null),
        max_human: human(r.max_bytes),
        avg_human: human(r.avg_bytes),
        total_human: human(r.total_bytes),
        max_bytes: Number(r.max_bytes),
        total_bytes: Number(r.total_bytes),
      };
    };
    report.json_blobs = {
      "user_integrations.store_snapshot": await blob("user_integrations", "store_snapshot"),
      "campaigns.brief_data": await blob("campaigns", "brief_data"),
      "campaigns.brief_data->storeInsights": await blob("campaigns", "brief_data", "brief_data->'storeInsights'"),
      "campaigns.store_insights": await blob("campaigns", "store_insights"),
      "campaign_brief_versions.brief_data": await blob("campaign_brief_versions", "brief_data"),
      "brief_generation_receipts.response": await blob("brief_generation_receipts", "response"),
    };
    if (has("user_integrations", "store_snapshot")) {
      const [s] = await q(`
        select coalesce(max(case when jsonb_typeof(store_snapshot->'products') = 'array'
                                 then jsonb_array_length(store_snapshot->'products') end), 0)::int as max_products
          from public.user_integrations`);
      report.json_blobs.max_products_in_a_snapshot = s.max_products;
    }

    // ── Shops, tokens, credits (counts only) ────────────────────────────────
    if (report.tables.some((t) => t.table === "user_integrations")) {
      const tokenCols = ["shopify_access_token", "access_token"].filter((c) => has("user_integrations", c));
      const expiryCols = ["token_expires_at", "shopify_token_expires_at"].filter((c) => has("user_integrations", c));
      const shopCols = ["shop_domain", "shopify_store_url"].filter((c) => has("user_integrations", c));
      const tokenExpr = tokenCols.length ? `coalesce(${tokenCols.join(", ")})` : "null";
      const expiryExpr = expiryCols.length ? `coalesce(${expiryCols.join(", ")})` : "null::timestamptz";
      const shopExpr = shopCols.length
        ? `nullif(lower(regexp_replace(regexp_replace(coalesce(${shopCols.join(", ")}), '^https?://', ''), '/.*$', '')), '')`
        : "null";
      const [s] = await q(`
        select count(*)::int as integration_rows,
               count(*) filter (where ${tokenExpr} is not null)::int as with_shopify_token,
               count(*) filter (where ${tokenExpr} is not null and ${expiryExpr} is null)::int as non_expiring_tokens,
               count(*) filter (where ${expiryExpr} > now())::int as unexpired_expiring_tokens,
               count(*) filter (where ${expiryExpr} <= now())::int as expired_tokens,
               count(distinct ${shopExpr})::int as distinct_shops
          from public.user_integrations`);
      const [dup] = await q(`
        select count(*)::int as shops_linked_to_multiple_users, coalesce(max(n), 0)::int as max_users_per_shop
          from (select ${shopExpr} as shop, count(distinct clerk_user_id) as n
                  from public.user_integrations where ${shopExpr} is not null
                 group by 1 having count(distinct clerk_user_id) > 1) d`);
      report.shops = { ...s, ...dup };
      if (has("user_integrations", "meta_access_token")) {
        const [m] = await q(`
          select count(*) filter (where meta_access_token is not null)::int as with_meta_token
            from public.user_integrations`);
        report.shops.with_meta_token = m.with_meta_token;
      }
      if (has("user_integrations", "scopes")) {
        const scopeType = typeOf("user_integrations", "scopes");
        const unnest =
          scopeType === "ARRAY"
            ? "unnest(scopes)"
            : "unnest(string_to_array(regexp_replace(scopes::text, '\\s', '', 'g'), ','))";
        const scopeRows = await q(`
          select scope, count(*)::int as n
            from public.user_integrations, lateral ${unnest} as scope
           where scopes is not null group by scope order by scope`);
        const [withScopes] = await q(
          `select count(*)::int as n from public.user_integrations where scopes is not null`,
        );
        report.stored_scopes = {
          rows_with_scopes: withScopes.n,
          frequency: Object.fromEntries(scopeRows.map((r) => [r.scope, r.n])),
          required_scopes_never_granted: REQUIRED_SCOPES.filter((sc) => !scopeRows.some((r) => r.scope === sc)),
        };
      }
      if (has("user_integrations", "credits") && has("user_integrations", "credits_balance")) {
        const [c] = await q(`
          select count(*) filter (where credits is distinct from credits_balance)::int as rows_where_balances_disagree,
                 count(*) filter (where coalesce(credits_balance, 0) > 0 and coalesce(credits, 0) = 0)::int
                   as rows_with_balance_hidden_by_legacy_column
            from public.user_integrations`);
        report.credits = c;
      }
    }

    // ── Activity (counts only) ──────────────────────────────────────────────
    if (has("campaigns", "created_at")) {
      const [a] = await q(`
        select count(*)::int as campaigns,
               count(*) filter (where created_at > now() - interval '30 days')::int as campaigns_last_30d,
               max(created_at) as latest_campaign_at
          from public.campaigns`);
      report.activity = a;
    }
    if (has("payments", "provider") && has("payments", "status")) {
      report.payments_by_provider_status = await q(`
        select provider, status, count(*)::int as n from public.payments group by 1, 2 order by 1, 2`);
    }

    // ── Client-role query history (pg_stat_statements) ──────────────────────
    const [ext] = await q(`
      select n.nspname as schema
        from pg_extension e join pg_namespace n on n.oid = e.extnamespace
       where e.extname = 'pg_stat_statements'`);
    if (ext && (roles.has("anon") || roles.has("authenticated"))) {
      const schema = ident(ext.schema);
      const tableNames = report.tables.map((t) => t.table);
      await client.query("SAVEPOINT pgss");
      try {
        let statsSince = null;
        try {
          const [info] = await q(`select stats_reset from ${schema}.pg_stat_statements_info`);
          statsSince = info?.stats_reset ?? null;
        } catch {
          await client.query("ROLLBACK TO SAVEPOINT pgss");
        }
        const rows = await q(`
          select r.rolname as role, s.calls::bigint as calls, s.query
            from ${schema}.pg_stat_statements s join pg_roles r on r.oid = s.userid
           where r.rolname in ('anon', 'authenticated')`);
        const agg = {};
        for (const row of rows) {
          const verb = (row.query.match(/\b(select|insert|update|delete)\b/i)?.[1] || "other").toUpperCase();
          const touched = tableNames.filter((t) =>
            new RegExp(`(^|[^a-z0-9_])"?${t}"?([^a-z0-9_]|$)`, "i").test(row.query),
          );
          for (const t of touched.length ? touched : ["(no public table)"]) {
            const key = `${row.role} ${verb} ${t}`;
            agg[key] = (agg[key] || 0) + Number(row.calls);
          }
        }
        report.client_role_query_history = {
          stats_since: statsSince,
          note: "Statements executed as anon/authenticated since stats reset (query text not shown).",
          calls: Object.fromEntries(Object.entries(agg).sort((a, b) => b[1] - a[1])),
        };
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT pgss").catch(() => {});
        report.client_role_query_history = { error: e.code || e.message };
      }
    }

    // ── Live Shopify granted scopes (optional) ──────────────────────────────
    if (flag("--shopify-scopes") && report.tables.some((t) => t.table === "user_integrations")) {
      const tokenCols = ["shopify_access_token", "access_token"].filter((c) => has("user_integrations", c));
      const expiryCols = ["token_expires_at", "shopify_token_expires_at"].filter((c) => has("user_integrations", c));
      const shopCols = ["shop_domain", "shopify_store_url"].filter((c) => has("user_integrations", c));
      if (tokenCols.length && shopCols.length) {
        const rows = await q(`
          select ${shopCols.join(", ")},
                 coalesce(${tokenCols.join(", ")}) as token,
                 ${expiryCols.length ? `coalesce(${expiryCols.join(", ")})` : "null::timestamptz"} as expires_at
            from public.user_integrations
           where coalesce(${tokenCols.join(", ")}) is not null`);
        report.shopify_live_scopes = await checkShopifyScopes(rows, shopCols);
      }
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }

  const out = option("--out");
  const json = JSON.stringify(report, null, 2);
  if (out) writeFileSync(out, json);
  console.log(json);
}

function myshopifyHost(row, shopCols) {
  for (const c of shopCols) {
    const raw = String(row[c] || "").trim().toLowerCase();
    const host = raw.replace(/^https?:\/\//, "").split("/")[0];
    if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) return host;
  }
  return null;
}

async function checkShopifyScopes(rows, shopCols) {
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const host = myshopifyHost(row, shopCols);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const label = flag("--show-shops") ? host : `shop_${hashLabel(host)}`;
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
    if (expiresAt !== null && expiresAt <= Date.now() + 60_000) {
      results.push({ shop: label, status: "not_checked_token_expired" });
      continue;
    }
    try {
      const res = await fetch(`https://${host}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": row.token },
        body: JSON.stringify({ query: "{ currentAppInstallation { accessScopes { handle } } }" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        results.push({ shop: label, status: `http_${res.status}` });
        continue;
      }
      const body = await res.json();
      const granted = (body?.data?.currentAppInstallation?.accessScopes || []).map((s) => s.handle);
      if (!granted.length) {
        results.push({ shop: label, status: body?.errors ? "graphql_error" : "no_scopes_returned" });
        continue;
      }
      results.push({
        shop: label,
        status: "checked",
        missing_required: REQUIRED_SCOPES.filter((s) => !granted.includes(s)),
        has_read_all_orders: granted.includes("read_all_orders"),
      });
    } catch (e) {
      results.push({ shop: label, status: `error_${e.name || "unknown"}` });
    }
  }
  return {
    required: REQUIRED_SCOPES,
    shops_considered: results.length,
    checked: results.filter((r) => r.status === "checked").length,
    results,
  };
}

main().catch((err) => {
  // Never echo the connection string (driver errors can include it).
  const msg = String(err?.message || err).replace(/postgres(ql)?:\/\/\S+/g, "[redacted]");
  console.error(`Inspection failed: ${err?.code || ""} ${msg}`);
  process.exit(1);
});
