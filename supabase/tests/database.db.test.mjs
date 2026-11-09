/**
 * Real Postgres tests (Phase 1, task 2). They run against a freshly provisioned
 * throwaway database, never a hosted one, and use synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 25 });
afterAll(() => pool.end());

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const unique = (label) => `test_${label}_${Math.random().toString(36).slice(2, 10)}`;

async function account({ credits = 0, shop = null, token = false } = {}) {
  const id = unique("user");
  await q(
    `insert into public.user_integrations (clerk_user_id, credits, credits_balance, free_credit_used, shop_domain, shopify_store_url, shopify_access_token, access_token, store_snapshot)
     values ($1, $2, $2, false, $3, $3, $4, $4, $5)`,
    [id, credits, shop, token ? `shpat_${unique("t")}` : null, shop ? { store: { domain: shop } } : null],
  );
  return id;
}

const balance = async (id) => (await q("select credits, credits_balance, credits_total_purchased from public.user_integrations where clerk_user_id = $1", [id]))[0];

describe("schema and migration state", () => {
  it("records migrations 0001 to 0017", async () => {
    const ids = (await q("select id from public.schema_migrations order by id")).map((row) => row.id);
    expect(ids.slice(0, 17).map((id) => id.slice(0, 4))).toEqual(Array.from({ length: 17 }, (_, i) => String(i + 1).padStart(4, "0")));
  });

  it("enables RLS on every table and gives anon and authenticated no table access", async () => {
    expect(await q("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity")).toEqual([]);
    expect(await q("select table_name, grantee from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')")).toEqual([]);
  });

  it("lets only service_role run the credit functions", async () => {
    for (const fn of ["add_user_credits(text,integer,integer)", "grant_free_credit(text)", "apply_credit_adjustment(text,text,integer,text,jsonb)"]) {
      const [row] = await q(
        `select has_function_privilege('anon', 'public.${fn}', 'execute') as anon, has_function_privilege('authenticated', 'public.${fn}', 'execute') as authed,
                has_function_privilege('service_role', 'public.${fn}', 'execute') as service`,
      );
      expect(row, fn).toEqual({ anon: false, authed: false, service: true });
    }
  });
});

describe("credit functions under concurrency", () => {
  it("applies 20 simultaneous grants exactly once each", async () => {
    const id = await account();
    await Promise.all(Array.from({ length: 20 }, () => q("select public.add_user_credits($1, 1, 1)", [id])));
    expect(await balance(id)).toEqual({ credits: 20, credits_balance: 20, credits_total_purchased: 20 });
  });

  it("grants the free credit once, however many requests arrive", async () => {
    const id = await account();
    const results = await Promise.all(Array.from({ length: 10 }, () => q("select public.grant_free_credit($1) as granted", [id])));
    expect(results.filter(([row]) => row.granted)).toHaveLength(1);
    expect((await balance(id)).credits_balance).toBe(1);
  });

  it("applies an adjustment once and never below zero", async () => {
    const id = await account();
    const key = unique("adjustment");
    const first = await q("select public.apply_credit_adjustment($1, $2, 5, 'test', '{}'::jsonb) as r", [key, id]);
    const again = await q("select public.apply_credit_adjustment($1, $2, 5, 'test', '{}'::jsonb) as r", [key, id]);
    expect([first[0].r, again[0].r]).toEqual(["applied", "already_applied"]);
    expect((await balance(id)).credits_balance).toBe(5);
    await expect(q("select public.apply_credit_adjustment($1, $2, -10, 'test', '{}'::jsonb)", [unique("adjustment"), id])).rejects.toThrow(/negative/);
  });
});

describe("webhook idempotency", () => {
  it("records one delivery when 20 identical deliveries race", async () => {
    const shop = `${unique("shop")}.myshopify.com`;
    const webhookId = unique("webhook");
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      q("insert into public.webhook_deliveries (shop_domain, webhook_id, topic) values ($1, $2, 'orders/paid') on conflict do nothing returning webhook_id", [shop, webhookId])));
    expect(results.flat()).toHaveLength(1);
  });

  it("claims a Purchase once per shop and order, but allows other event types", async () => {
    const shop = `${unique("shop")}.myshopify.com`;
    const id = await account({ shop });
    const insert = (eventType) => q(
      `insert into public.capi_events (shop_domain, event_type, clerk_user_id, shopify_order_id, order_value, currency, status)
       values ($1, $2, $3, '1001', 10, 'USD', 'pending') on conflict do nothing returning id`, [shop, eventType, id]);
    const results = await Promise.all(Array.from({ length: 20 }, () => insert("Purchase")));
    expect(results.flat()).toHaveLength(1);
    expect(await insert("Refund")).toHaveLength(1);
  });
});

describe("uninstall and redaction stay separate", () => {
  it("disconnects every account on the shop and keeps their data", async () => {
    const shop = `${unique("shop")}.myshopify.com`;
    const [a, b] = [await account({ shop, token: true, credits: 4 }), await account({ shop, token: true })];
    const other = await account({ shop: `${unique("other")}.myshopify.com`, token: true });
    await q("select public.disconnect_shop_installation($1)", [shop]);
    const rows = await q("select clerk_user_id, shopify_access_token, shopify_uninstalled_at, store_snapshot, credits_balance from public.user_integrations where clerk_user_id = any($1)", [[a, b, other]]);
    const byId = Object.fromEntries(rows.map((row) => [row.clerk_user_id, row]));
    for (const id of [a, b]) {
      expect(byId[id].shopify_access_token).toBeNull();
      expect(byId[id].shopify_uninstalled_at).not.toBeNull();
      expect(byId[id].store_snapshot).not.toBeNull();
    }
    expect(byId[a].credits_balance).toBe(4);
    expect(byId[other].shopify_access_token).not.toBeNull();
  });

  it("redacts the shop's data but keeps the account and its credits", async () => {
    const shop = `${unique("shop")}.myshopify.com`;
    const id = await account({ shop, token: true, credits: 7 });
    await q("select public.redact_shop_data($1)", [shop]);
    const [row] = await q("select shop_domain, shopify_access_token, store_snapshot, credits_balance from public.user_integrations where clerk_user_id = $1", [id]);
    expect(row).toEqual({ shop_domain: null, shopify_access_token: null, store_snapshot: null, credits_balance: 7 });
  });
});
