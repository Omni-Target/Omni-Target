/**
 * Real Postgres tests for inventory and fulfilment (Phase 3, task 3;
 * migration 0046): every quantity state, locations with their fulfilment
 * services, complete-item level replacement, and availability that never takes
 * one location for the shop. Synthetic rows only.
 *
 *   TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm test:db
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required. Provision a throwaway database with supabase/provision.mjs first.");
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("Database tests run only against a local or CI database.");

const pool = new pg.Pool({ connectionString: url, max: 10 });
afterAll(() => pool.end());
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
async function as(role, sql, params) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
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
const call = async (fn, ...args) => (await as("service_role", `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as result`, args))[0].result;
const json = (value) => JSON.stringify(value);
const inventory = (key, locations, levels, complete = null) => call("ingest_inventory", key, json(locations), json(levels), complete);
const catalog = (key, products, variants) => call("ingest_catalog", key, json(products), json(variants), "[]");

let counter = 0;
const tag = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function boundShop() {
  const shop = `v-${tag()}.myshopify.com`;
  await one("select public.bind_shop_for_install($1, $2, $3, null, 'Test shop')", [Math.floor(Math.random() * 9e12) + 1e12, shop, `user_${tag()}`]);
  const { shop_key: key } = await one("select shop_key from public.shops where myshopify_domain = $1", [shop]);
  return { shop, key };
}

const T1 = "2026-11-01T00:00:00Z";
const T2 = "2026-11-02T00:00:00Z";
const location = (id, extra = {}) => ({ shopify_id: id, name: `L${id}`, country_code: "GB", is_active: true, fulfills_online_orders: true, is_fulfillment_service: false, fields_version: 2, ...extra });
const level = (item, loc, available, extra = {}) => ({
  inventory_item_id: item, location_shopify_id: loc, available, on_hand: available, committed: 0, incoming: 0, reserved: 0, damaged: 0,
  safety_stock: 0, quality_control: 0, is_active: true, shopify_updated_at: T1, ...extra,
});
const variant = (id, productId, item, extra = {}) => ({ shopify_id: id, product_shopify_id: productId, price: "10", inventory_item_id: item, tracked: true, inventory_policy: "deny", shopify_updated_at: T1, ...extra });

describe("inventory and fulfilment (0046)", () => {
  it("stores every quantity state and the locations' fulfilment services", async () => {
    const s = await boundShop();
    await inventory(s.key, [location(1), location(2, { is_fulfillment_service: true, fulfillment_service_handle: "shipbob", fulfillment_service_name: "ShipBob",
      fulfillment_service_type: "third_party", fulfillment_service_inventory: true, ships_inventory: true })],
    [level(100, 1, 4, { committed: 2, incoming: 10, on_hand: 7, reserved: 1 })]);
    expect(await one("select available, committed, incoming, on_hand, reserved, is_active from public.inventory_levels where shop_key = $1", [s.key]))
      .toEqual({ available: 4, committed: 2, incoming: 10, on_hand: 7, reserved: 1, is_active: true });
    expect(await one("select fulfillment_service_type, fulfillment_service_name, fields_version from public.inventory_locations where shop_key = $1 and shopify_id = 2", [s.key]))
      .toEqual({ fulfillment_service_type: "third_party", fulfillment_service_name: "ShipBob", fields_version: 2 });
    await expect(inventory(s.key, [location(3, { fulfillment_service_type: "dropship" })], [])).rejects.toThrow(/fulfillment_service_type/);
  });

  it("replaces a complete item's levels, keeps others, and never lets an older level win", async () => {
    const s = await boundShop();
    await inventory(s.key, [location(1), location(2)], [level(100, 1, 4), level(100, 2, 3), level(200, 1, 9)]);
    // A bulk batch is not complete: nothing is removed.
    expect(await inventory(s.key, [], [level(100, 1, 5, { shopify_updated_at: T2 })])).toMatchObject({ levels: 1, levels_removed: 0 });
    // A by-ID read of item 100: it no longer stocks location 2. Item 200 is untouched.
    expect(await inventory(s.key, [], [level(100, 1, 5, { shopify_updated_at: T2 })], [100])).toMatchObject({ levels_removed: 1 });
    expect(await q("select inventory_item_id, location_shopify_id, available from public.inventory_levels where shop_key = $1 order by 1, 2", [s.key]))
      .toEqual([{ inventory_item_id: "100", location_shopify_id: "1", available: 5 }, { inventory_item_id: "200", location_shopify_id: "1", available: 9 }]);
    // Older than what is stored: ignored.
    await inventory(s.key, [], [level(100, 1, 1, { shopify_updated_at: T1 })]);
    expect((await one("select available from public.inventory_levels where shop_key = $1 and inventory_item_id = 100", [s.key])).available).toBe(5);
  });

  it("gives availability by location and over the online locations only, with a state and who fulfils it", async () => {
    const s = await boundShop();
    await catalog(s.key, [{ shopify_id: 1, title: "Board", status: "active", tags: ["Shopify Collective", "Supplier Co"], shopify_updated_at: T1 },
                         { shopify_id: 2, title: "Wax", status: "active", tags: [], shopify_updated_at: T1 }],
      [variant(11, 1, 110), variant(12, 1, 120, { inventory_policy: "continue" }), variant(13, 1, 130), variant(14, 1, 140, { tracked: false }),
       variant(15, 1, 150), variant(21, 2, null)]);
    await inventory(s.key, [
      location(1),                                                  // warehouse, online
      location(2, { fulfills_online_orders: false }),               // shop floor, not online
      location(3, { is_fulfillment_service: true, fulfillment_service_type: "third_party" }), // 3PL, online
      location(4, { is_active: false }),                            // closed
    ], [
      level(110, 1, 4, { damaged: 1, reserved: 2, committed: 3 }), level(110, 2, 10), level(110, 3, 7), level(110, 4, 50), level(110, 9, 5), // 9: unknown location
      level(120, 1, 0), level(130, 1, 0), level(130, 2, 25),         // stock only off line
      level(150, 1, 6, { is_active: false }),                       // stocking stopped at this location
    ]);
    const rows = await call("inventory_availability", s.key, [11, 12, 13, 14, 15, 21, 99]);
    const by = Object.fromEntries(rows.map((r) => [r.variant_id, r]));
    expect(Object.keys(by).map(Number)).toEqual([11, 12, 13, 14, 15, 21]);

    expect(by[11]).toMatchObject({
      state: "in_stock", collective: true, quantities_read: true, unknown_locations: 1,
      online: { locations: 2, available: 11, committed: 3, unavailable: 3, on_hand: 11 },
      active: { locations: 3, available: 21 },
    });
    expect([...by[11].fulfilment].sort()).toEqual(["merchant", "third_party"]);
    expect(by[11].locations.find((l) => l.location_id === 9)).toMatchObject({ known: false, online: false });
    // Stock at one location is never the shop's: 25 off line, none online, so out of stock online.
    expect(by[13]).toMatchObject({ state: "out_of_stock", online: { available: 0 }, active: { available: 25 } });
    expect(by[12]).toMatchObject({ state: "oversell_allowed" });
    expect(by[14]).toMatchObject({ state: "untracked" });
    expect(by[15]).toMatchObject({ state: "out_of_stock", online: { locations: 0 } });
    expect(by[21]).toMatchObject({ state: "unknown", collective: false, locations: [] });

    // The read path's variants carry tracking, policy and online availability.
    const [board] = await call("insight_products", s.key, [1]);
    expect(board.variants.map((v) => [v.id, v.tracked, v.inventory_policy, v.available_online])).toEqual([
      [11, true, "deny", 11], [12, true, "continue", 0], [13, true, "deny", 0], [14, false, "deny", null], [15, true, "deny", null],
    ]);
  });

  it("is reachable by the service role only", async () => {
    const s = await boundShop();
    for (const role of ["anon", "authenticated"]) {
      await expect(as(role, "select public.inventory_availability($1, '{1}')", [s.key])).rejects.toThrow(/permission denied/);
      await expect(as(role, "select public.ingest_inventory($1, '[]', '[]', null)", [s.key])).rejects.toThrow(/permission denied/);
    }
  });
});
