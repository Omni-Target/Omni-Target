/**
 * Real Postgres tests for redaction suppression and the ingestion guard
 * (Phase 2, task 2; migration 0031). Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { randomBytes, randomUUID } from "node:crypto";
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
const call = async (fn, ...args) =>
  (await asService(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args))[0].result;
const asOwner = async (fn, ...args) =>
  (await one(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args)).result;
const dbNow = async () => (await one("select clock_timestamp()::text as t")).t;

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const shopifyId = () => Math.floor(Math.random() * 9e12) + 1e12;
const digest = () => randomBytes(32);

/** A shop installed into an active workspace, as the OAuth callback leaves it. */
async function boundShop() {
  const shop = `s-${tag()}.myshopify.com`;
  const shopify = shopifyId();
  const installed = await asOwner("bind_shop_for_install", shopify, shop, `user_${tag()}`, null, "Test shop");
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, shopify, key, workspace: installed.workspace_id };
}
const redact = (s, customer, orders, customerDigest, orderDigests, eventKey = randomUUID(), topic = "customers/redact") =>
  call("record_customer_compliance", topic, s.shopify, s.shop, eventKey, new Date(), customer, orders, customerDigest, orderDigests, 1);
const suppressions = (shopify) =>
  q("select subject_type, compliance_request_id from public.redaction_suppressions where shopify_shop_id = $1 order by subject_type", [shopify]);

describe("redaction suppression (Phase 2 decision 5)", () => {
  it("records the customer and every named order on customers/redact, once, linked to the request", async () => {
    const s = await boundShop();
    const [customer, order] = [digest(), digest()];
    const key = randomUUID();
    const result = await redact(s, 501, [601], customer, [order], key);
    expect(result).toMatchObject({ outcome: "completed", suppressed: 2 });
    expect(await suppressions(s.shopify)).toEqual([
      { subject_type: "customer", compliance_request_id: result.compliance_request_id },
      { subject_type: "order", compliance_request_id: result.compliance_request_id },
    ]);

    expect(await redact(s, 501, [601], customer, [order], key)).toEqual({ outcome: "duplicate" });
    expect((await redact(s, 501, [601], customer, [order])).suppressed).toBe(0);
    expect(await suppressions(s.shopify)).toHaveLength(2);
  });

  it("records nothing for a data request", async () => {
    const s = await boundShop();
    const result = await redact(s, 501, [601], digest(), [digest()], randomUUID(), "customers/data_request");
    expect(result.suppressed).toBe(0);
    expect(await suppressions(s.shopify)).toEqual([]);
  });

  it("keys suppressions by the Shopify shop ID, so they hold for a shop never modelled and survive the shop's deletion", async () => {
    const unmodelled = { shop: `u-${tag()}.myshopify.com`, shopify: shopifyId() };
    expect((await redact(unmodelled, 7, [], digest(), [])).suppressed).toBe(1);
    expect(await suppressions(unmodelled.shopify)).toHaveLength(1);

    const s = await boundShop();
    await redact(s, 8, [9], digest(), [digest()]);
    await call("begin_uninstall", s.shopify, s.shop, randomUUID(), await dbNow());
    const started = await call("record_shop_redact", s.shopify, s.shop, randomUUID(), await dbNow());
    expect(await call("process_workspace_deletion", started.deletion_id)).toMatchObject({ outcome: "completed" });
    expect(await suppressions(s.shopify)).toHaveLength(2);
  });

  it("answers which of a batch's digests are suppressed, for that shop and subject type only", async () => {
    const s = await boundShop();
    const [suppressedCustomer, suppressedOrder, other] = [digest(), digest(), digest()];
    await redact(s, 1, [2], suppressedCustomer, [suppressedOrder]);
    const found = await call("suppressed_subjects", s.shopify, "customer", [suppressedCustomer, suppressedOrder, other]);
    expect(found).toEqual([suppressedCustomer]);
    expect(await call("suppressed_subjects", shopifyId(), "customer", [suppressedCustomer])).toEqual([]);
    expect(await call("suppressed_subjects", s.shopify, "order", null)).toEqual([]);
  });

  it("rejects a digest that is not 32 bytes", async () => {
    await expect(q("insert into public.redaction_suppressions (shopify_shop_id, subject_type, subject_digest) values ($1, 'customer', $2)", [shopifyId(), randomBytes(31)]))
      .rejects.toThrow(/check constraint/);
  });
});

describe("ingestion guard", () => {
  it("admits only a shop bound to an active workspace", async () => {
    const s = await boundShop();
    expect(await call("shop_ingestion_open", s.key)).toBe(true);
    await call("begin_uninstall", s.shopify, s.shop, randomUUID(), await dbNow());
    expect(await call("shop_ingestion_open", s.key)).toBe(false);

    const { shop_key: unbound } = await one("insert into public.shops (shopify_shop_id, myshopify_domain) values ($1, $2) returning shop_key", [shopifyId(), `n-${tag()}.myshopify.com`]);
    expect(await call("shop_ingestion_open", unbound)).toBe(false);
    await expect(asOwner("lock_shop_for_ingestion", unbound)).rejects.toThrow(/shop_not_ingestible/);
  });

  it("holds the workspace until the write commits, so a lifecycle change cannot interleave", async () => {
    const s = await boundShop();
    const writer = await pool.connect();
    const lifecycle = await pool.connect();
    try {
      await writer.query("begin");
      expect((await writer.query("select public.lock_shop_for_ingestion($1) as w", [s.key])).rows[0].w).toBe(s.workspace);
      await lifecycle.query("begin");
      await lifecycle.query("set local lock_timeout = '300ms'");
      await expect(lifecycle.query("update public.workspaces set status = 'disconnected' where id = $1", [s.workspace])).rejects.toThrow(/lock timeout/);
      await lifecycle.query("rollback");
      await writer.query("commit");
      await lifecycle.query("update public.workspaces set status = 'disconnected' where id = $1", [s.workspace]);
      await expect(asOwner("lock_shop_for_ingestion", s.key)).rejects.toThrow(/shop_not_ingestible/);
    } finally {
      writer.release();
      lifecycle.release();
    }
  });
});

describe("privileges", () => {
  it("lets service_role read suppressions and call the guard and lookups, but not write suppressions or take the lock directly", async () => {
    for (const [fn, service] of [
      ["suppressed_subjects(bigint, text, bytea[])", true],
      ["shop_ingestion_open(integer)", true],
      ["record_customer_compliance(text, bigint, text, text, timestamptz, bigint, bigint[], bytea, bytea[], smallint)", true],
      ["lock_shop_for_ingestion(integer)", false],
    ]) {
      const row = await one(
        `select has_function_privilege('service_role', $1, 'execute') as service,
                has_function_privilege('anon', $1, 'execute') or has_function_privilege('authenticated', $1, 'execute') as public_exec`, [`public.${fn}`]);
      expect(row, fn).toEqual({ service, public_exec: false });
    }
    expect(await one(
      `select c.relrowsecurity as rls, has_table_privilege('service_role', c.oid, 'select') as read,
              has_table_privilege('service_role', c.oid, 'insert') or has_table_privilege('service_role', c.oid, 'delete') as write,
              has_table_privilege('anon', c.oid, 'select') as anon
         from pg_class c where c.oid = 'public.redaction_suppressions'::regclass`))
      .toEqual({ rls: true, read: true, write: false, anon: false });
    expect(await one("select count(*)::int as n from pg_proc where proname = 'record_customer_compliance'")).toEqual({ n: 1 });
  });
});
