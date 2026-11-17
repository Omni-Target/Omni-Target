/**
 * Real Postgres tests for operational hygiene (Phase 1, task 10; DATA-07):
 * migration 0028. Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 10 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

async function asService(sql, params) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
const call = async (sql, params) => (await asService(sql, params))[0].r;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe("operational hygiene (task 10, DATA-07)", () => {
  it("indexes the user columns that deletion and redaction filter on", async () => {
    const names = (await q("select indexname from pg_indexes where schemaname = 'public'")).map((r) => r.indexname);
    for (const index of ["capi_events_user_idx", "payments_user_idx", "credit_usage_user_idx", "api_usage_log_user_idx", "rate_limits_window_idx"]) {
      expect(names, index).toContain(index);
    }
  });

  it("prunes rate-limit windows older than a day and webhook dedupe keys older than 30 days, keeping recent ones", async () => {
    const [oldKey, newKey] = [`old:${tag()}`, `new:${tag()}`];
    await q("insert into public.rate_limits (key, count, window_start) values ($1, 3, now() - interval '2 days'), ($2, 1, now() - interval '30 minutes')", [oldKey, newKey]);
    const [oldHook, newHook] = [randomUUID(), randomUUID()];
    await q("insert into public.webhook_deliveries (shop_domain, webhook_id, topic, received_at) values ('h.myshopify.com', $1, 'orders/paid', now() - interval '31 days'), ('h.myshopify.com', $2, 'orders/paid', now() - interval '2 days')", [oldHook, newHook]);

    const pruned = await call("select public.prune_operational_rows() as r");
    expect(pruned.rate_limits).toBeGreaterThanOrEqual(1);
    expect(pruned.webhook_deliveries).toBeGreaterThanOrEqual(1);
    expect((await q("select key from public.rate_limits where key = any($1)", [[oldKey, newKey]])).map((r) => r.key)).toEqual([newKey]);
    expect((await q("select webhook_id from public.webhook_deliveries where webhook_id = any($1)", [[oldHook, newHook]])).map((r) => r.webhook_id)).toEqual([newHook]);
  });

  it("claims an email send once per window, even under concurrent runs, and can give a claim back", async () => {
    const user = `user_mail_${tag()}`;
    const claims = await Promise.all(Array.from({ length: 5 }, () => call("select public.claim_email_send($1, 'brief-nudge', interval '7 days') as r", [user])));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await call("select public.claim_email_send($1, 'brief-nudge', interval '7 days') as r", [user])).toBeNull();
    expect(await call("select public.claim_email_send($1, 'welcome', interval '7 days') as r", [user])).not.toBeNull();

    await asService("select public.release_email_claim($1)", [claims.find(Boolean)]);
    expect(await call("select public.claim_email_send($1, 'brief-nudge', interval '7 days') as r", [user])).not.toBeNull();

    const lapsed = `user_mail_${tag()}`;
    await q("insert into public.email_log (user_id, template, sent_at) values ($1, 'brief-nudge', now() - interval '8 days')", [lapsed]);
    expect(await call("select public.claim_email_send($1, 'brief-nudge', interval '7 days') as r", [lapsed])).not.toBeNull();
    await expect(asService("select public.claim_email_send('', 'brief-nudge', interval '7 days')")).rejects.toThrow("email_claim_invalid");
  });

  it("lists accounts due a nudge in one query: old enough, no saved brief, not nudged this week", async () => {
    const account = async (age) => {
      const user = `user_nudge_${tag()}`;
      await q("insert into public.user_integrations (clerk_user_id, created_at) values ($1, now() - $2::interval)", [user, age]);
      return user;
    };
    const due = [await account("10 days"), await account("9 days")];
    const withBrief = await account("10 days");
    await q("insert into public.campaigns (clerk_user_id, product_name) values ($1, 'Lamp')", [withBrief]);
    const nudged = await account("10 days");
    await q("insert into public.email_log (user_id, template, sent_at) values ($1, 'brief-nudge', now() - interval '2 days')", [nudged]);
    const tooNew = await account("1 hour");

    const listed = (await asService("select public.brief_nudge_candidates(now() - interval '48 hours', 500) as id")).map((r) => r.id);
    for (const user of due) expect(listed).toContain(user);
    for (const user of [withBrief, nudged, tooNew]) expect(listed).not.toContain(user);
    expect(listed.indexOf(due[0])).toBeLessThan(listed.indexOf(due[1]));
    expect(await asService("select public.brief_nudge_candidates(now() - interval '48 hours', 1) as id")).toHaveLength(1);
  });

  it("lets only the service role run the hygiene functions", async () => {
    for (const fn of ["prune_operational_rows()", "claim_email_send(text, text, interval)", "release_email_claim(uuid)", "brief_nudge_candidates(timestamptz, integer)"]) {
      expect(await one(
        `select has_function_privilege('service_role', $1, 'execute') as service, has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authed`, [`public.${fn}`])).toEqual({ service: true, anon: false, authed: false });
    }
  });
});
