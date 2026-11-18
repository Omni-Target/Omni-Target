import "server-only";
import { supabaseAdmin } from "@/platform/supabase";
import type { ShopAccessReport } from "./access";

/** The shop's integer key in the commerce mirror (0029), or null for a shop never modelled. */
export async function shopKeyFor(domain: string): Promise<number | null> {
  const { data, error } = await supabaseAdmin.from("shops").select("shop_key").eq("myshopify_domain", domain).maybeSingle();
  if (error) throw new Error(`Shop lookup failed: ${error.message}`);
  return (data?.shop_key as number | undefined) ?? null;
}

/** Stores the capability matrix the import plans from (shop_access, 0024). */
export async function recordShopAccess(shopKey: number, report: ShopAccessReport): Promise<void> {
  const { error } = await supabaseAdmin.from("shop_access").upsert(
    {
      shop_key: shopKey,
      granted_scopes: report.grantedScopes,
      domains: report.domains,
      withheld_fields: report.withheldFields,
      checked_at: new Date().toISOString(),
    },
    { onConflict: "shop_key" },
  );
  if (error) throw new Error(`Shop access not recorded: ${error.message}`);
}
