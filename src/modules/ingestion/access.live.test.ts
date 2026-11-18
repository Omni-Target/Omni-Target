/**
 * Live access check (Phase 2, task 1): what a real shop granted, through the
 * staging database's stored credential. Prints scopes, domain statuses and
 * withheld field names only, never customer data. Opt-in; see
 * vitest.live.config.mjs. Refuses any database but the staging project.
 */
import { describe, expect, it } from "vitest";

const STAGING_REF = "eraycbxedmufsdvhtrvk";

describe("live Shopify access check", () => {
  it("verifies the shop's granted scopes and Level 1 fields, and records them", async () => {
    const domain = process.env.LIVE_SHOP_DOMAIN;
    if (!domain) throw new Error("LIVE_SHOP_DOMAIN is required");
    if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)) throw new Error("Refusing: not the staging database");

    const { checkShopAccess } = await import("./access-check");
    const result = await checkShopAccess(domain);
    console.log(JSON.stringify(result, null, 2));
    expect(result.outcome).toBe("checked");
  });
});
