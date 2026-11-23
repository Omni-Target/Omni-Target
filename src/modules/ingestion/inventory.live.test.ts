/**
 * Live inventory check (Phase 3, task 3): stored locations (with fulfilment
 * services) and inventory levels (every quantity state) compared with
 * Shopify's raw answer, and the stored availability's online total recomputed
 * independently from Shopify's own levels and locations.
 *
 * Options, each writing to staging first:
 *  - LIVE_REFRESH_LOCATIONS=1 runs the daily locations refresh;
 *  - LIVE_RESYNC_ITEMS=N re-reads N inventory items through the incremental
 *    sync's by-ID path (replay events processed here).
 * Items are sampled from those read with Phase 3's quantities, at most
 * LIVE_SAMPLE (default 50). Opt-in; staging only. Writes LIVE_OUT.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";
type Raw = Record<string, unknown>;
const NAMES = ["available", "committed", "incoming", "on_hand", "reserved", "damaged", "safety_stock", "quality_control"];
const RAW_LOCATIONS = `query L($after: String) { locations(first: 250, after: $after, includeInactive: true, includeLegacy: true) {
  nodes { id name isActive fulfillsOnlineOrders isFulfillmentService shipsInventory fulfillmentService { handle type } }
  pageInfo { hasNextPage endCursor } } }`;
const RAW_ITEMS = `query I($ids: [ID!]!) { nodes(ids: $ids) { ... on InventoryItem { id
  inventoryLevels(first: 50) { nodes { isActive location { id } quantities(names: ${JSON.stringify(NAMES)}) { name quantity } } } } } }`;
const idOf = (gid: unknown) => Number(String(gid).split("/").pop());

describe("live inventory", () => {
  it("stores Shopify's locations and every quantity state, and totals only online locations", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");
    const { getShopifyAccessForShop } = await import("@/modules/credentials/shopify");
    const { shopifyGraphql } = await import("@/lib/connectors/shopify-graphql");
    const { supabaseAdmin } = await import("@/platform/supabase");
    const { data: shop } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).single();
    if (!shop) throw new Error("shop not modelled");
    const access = await getShopifyAccessForShop(domain);
    if (access.status !== "ok") throw new Error(`no access: ${access.status}`);
    const gql = <T,>(query: string, variables?: Raw) => shopifyGraphql<T>(domain, access.accessToken, query, variables);
    const report: Record<string, unknown> = {};

    if (process.env.LIVE_REFRESH_LOCATIONS === "1") {
      const { refreshLocations } = await import("./sync-live");
      report.locationsRefresh = await refreshLocations(domain);
    }
    const resync = Number(process.env.LIVE_RESYNC_ITEMS ?? 0);
    if (resync > 0) {
      const { recordSyncEvents } = await import("./sync-repository");
      const { processShopEvents } = await import("./sync");
      const { liveSyncDeps } = await import("./sync-live");
      const { data: picked } = await supabaseAdmin.from("inventory_levels").select("inventory_item_id, location_shopify_id")
        .eq("shop_key", shop.shop_key).is("committed", null).order("inventory_item_id").limit(resync);
      const tag = `p3-inventory-${Date.now().toString(36)}`;
      await recordSyncEvents(domain, (picked ?? []).map((l) => ({
        webhook_id: `reconcile:${tag}:inventory_levels/update:${l.inventory_item_id}:${l.location_shopify_id}`, topic: "inventory_levels/update",
        triggered_at: new Date().toISOString(), payload: { inventory_item_id: Number(l.inventory_item_id), location_id: Number(l.location_shopify_id), updated_at: new Date().toISOString() },
      })));
      report.resynced = await processShopEvents(domain, randomUUID(), liveSyncDeps(), { budgetMs: 600_000 });
    }

    const mismatches: string[] = [];
    const differ = (where: string, want: unknown, got: unknown) => {
      if (JSON.stringify(want ?? null) !== JSON.stringify(got ?? null)) mismatches.push(`${where}: shopify ${JSON.stringify(want)} stored ${JSON.stringify(got)}`);
    };

    // Locations, in full.
    const rawLocations: Raw[] = [];
    for (let after: string | null = null; ;) {
      const page: { locations: { nodes: Raw[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(RAW_LOCATIONS, { after });
      rawLocations.push(...page.locations.nodes);
      if (!page.locations.pageInfo.hasNextPage) break;
      after = page.locations.pageInfo.endCursor;
    }
    const { data: storedLocations } = await supabaseAdmin.from("inventory_locations")
      .select("shopify_id, name, is_active, fulfills_online_orders, is_fulfillment_service, ships_inventory, fulfillment_service_handle, fulfillment_service_type")
      .eq("shop_key", shop.shop_key);
    for (const r of rawLocations) {
      const id = idOf(r.id);
      const s = (storedLocations ?? []).find((l) => Number(l.shopify_id) === id);
      if (!s) { mismatches.push(`location ${id}: not stored`); continue; }
      const service = r.fulfillmentService as Raw | null;
      differ(`location ${id}`, [r.name, r.isActive, r.fulfillsOnlineOrders, r.isFulfillmentService, r.shipsInventory, service?.handle ?? null, service?.type ? String(service.type).toLowerCase() : null],
        [s.name, s.is_active, s.fulfills_online_orders, s.is_fulfillment_service, s.ships_inventory, s.fulfillment_service_handle, s.fulfillment_service_type]);
    }
    const online = new Set(rawLocations.filter((l) => l.isActive && l.fulfillsOnlineOrders).map((l) => idOf(l.id)));

    // Levels, for items read with Phase 3's quantities.
    const { data: sampledLevels } = await supabaseAdmin.from("inventory_levels").select("inventory_item_id")
      .eq("shop_key", shop.shop_key).not("committed", "is", null).order("synced_at", { ascending: false }).limit(Number(process.env.LIVE_SAMPLE ?? 50) * 3);
    const items = [...new Set((sampledLevels ?? []).map((l) => Number(l.inventory_item_id)))].slice(0, Number(process.env.LIVE_SAMPLE ?? 50));
    if (!items.length) throw new Error("no inventory level read with Phase 3's quantities");
    let levelsChecked = 0;
    let availabilityChecked = 0;
    for (let i = 0; i < items.length; i += 50) {
      const slice = items.slice(i, i + 50);
      const { nodes } = await gql<{ nodes: Array<Raw | null> }>(RAW_ITEMS, { ids: slice.map((id) => `gid://shopify/InventoryItem/${id}`) });
      const { data: stored } = await supabaseAdmin.from("inventory_levels").select(`inventory_item_id, location_shopify_id, is_active, ${NAMES.join(", ")}`)
        .eq("shop_key", shop.shop_key).in("inventory_item_id", slice);
      const { data: variants } = await supabaseAdmin.from("product_variants").select("shopify_id, inventory_item_id, tracked").eq("shop_key", shop.shop_key).in("inventory_item_id", slice);
      const variantIds = (variants ?? []).map((v) => Number(v.shopify_id));
      const { data: availability } = await supabaseAdmin.rpc("inventory_availability", { p_shop_key: shop.shop_key, p_variant_ids: variantIds });
      slice.forEach((item, index) => {
        const raw = nodes[index];
        if (!raw) { mismatches.push(`item ${item}: Shopify no longer has it`); return; }
        const rawLevels = ((raw.inventoryLevels as { nodes: Raw[] }).nodes ?? []).map((n) => ({
          location: idOf((n.location as Raw).id), active: n.isActive,
          q: Object.fromEntries(((n.quantities as Raw[]) ?? []).map((x) => [x.name, x.quantity])),
        }));
        const mine = (stored ?? []).filter((l) => Number(l.inventory_item_id) === item);
        differ(`item ${item} locations`, rawLevels.map((l) => l.location).sort(), mine.map((l) => Number(l.location_shopify_id)).sort());
        for (const r of rawLevels) {
          const s = mine.find((l) => Number(l.location_shopify_id) === r.location) as Record<string, unknown> | undefined;
          if (!s) continue;
          levelsChecked += 1;
          differ(`item ${item} location ${r.location}`, [r.active, ...NAMES.map((n) => r.q[n])], [s.is_active, ...NAMES.map((n) => s[n])]);
        }
        // The online total, recomputed from Shopify's own data.
        const variant = (variants ?? []).find((v) => Number(v.inventory_item_id) === item);
        const row = ((availability as Array<Raw> | null) ?? []).find((a) => variant && Number(a.variant_id) === Number(variant.shopify_id));
        if (variant && row) {
          availabilityChecked += 1;
          const onlineLevels = rawLevels.filter((l) => online.has(l.location) && l.active !== false);
          const want = onlineLevels.length ? onlineLevels.reduce((n, l) => n + Number(l.q.available ?? 0), 0) : null;
          differ(`item ${item} online available`, want, (row.online as Raw).available);
        }
      });
    }

    Object.assign(report, { locations: rawLocations.length, items: items.length, levels: levelsChecked, availability: availabilityChecked,
      mismatches: mismatches.slice(0, 50), mismatchCount: mismatches.length });
    const out = JSON.stringify(report, null, 2);
    if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, out);
    else console.log(out);
    expect(mismatches).toEqual([]);
  }, 900_000);
});
