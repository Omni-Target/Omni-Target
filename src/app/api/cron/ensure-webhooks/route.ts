import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db";
import { shopifyAdminRestUrl } from "@/lib/shopify-config";
import { safeEqual } from "@/lib/shopify-oauth";
import { getValidShopifyToken } from "@/lib/shopify-token";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * SEC-09 / ING-05 rollout: brings already-installed shops up to the webhook
 * subscriptions that new installs get. Run by hand with CRON_SECRET; it is not
 * scheduled. Reports only unless called with ?apply=true, and never removes a
 * subscription. See scripts/ops/runbooks/webhook-rollout.md.
 */
const REQUIRED_TOPICS = ["orders/paid", "app/uninstalled"];
const PAGE_SIZE = 25;
const SHOPIFY_TIMEOUT_MS = 8_000;

type ShopOutcome = {
  shop: string;
  status: "complete" | "missing" | "repaired" | "partial" | "skipped" | "failed";
  missing: string[];
  created: string[];
  reason?: string;
};

const normalizeHost = (value: string | null | undefined) =>
  value?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "") || null;

const maskShop = (shop: string) => `${shop.slice(0, 4)}…`;

async function usableToken(userIds: string[]): Promise<{ token?: string; reason?: string }> {
  let reason: string | undefined;
  for (const userId of userIds) {
    const result = await getValidShopifyToken(userId);
    if (result.status === "ok") return { token: result.accessToken };
    reason = result.status;
  }
  return { reason };
}

async function reconcileShop(shop: string, userIds: string[], address: string, apply: boolean): Promise<ShopOutcome> {
  const outcome = (status: ShopOutcome["status"], missing: string[] = [], created: string[] = [], reason?: string): ShopOutcome => ({
    shop: maskShop(shop),
    status,
    missing,
    created,
    ...(reason ? { reason } : {}),
  });

  try {
    const { token, reason } = await usableToken(userIds);
    if (!token) return outcome("skipped", [], [], reason);

    const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": token };
    const listed = await fetch(shopifyAdminRestUrl(shop, "webhooks.json?limit=250"), {
      headers,
      signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
    });
    if (!listed.ok) return outcome("failed", [], [], `list_${listed.status}`);

    const { webhooks = [] } = (await listed.json()) as { webhooks?: { topic: string; address: string }[] };
    const present = new Set(webhooks.filter((hook) => hook.address === address).map((hook) => hook.topic));
    const missing = REQUIRED_TOPICS.filter((topic) => !present.has(topic));
    if (missing.length === 0) return outcome("complete");
    if (!apply) return outcome("missing", missing);

    const created: string[] = [];
    for (const topic of missing) {
      const response = await fetch(shopifyAdminRestUrl(shop, "webhooks.json"), {
        method: "POST",
        headers,
        body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
        signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
      });
      // 422 means this topic and address already exist.
      if (response.ok || response.status === 422) created.push(topic);
    }
    return outcome(created.length === missing.length ? "repaired" : "partial", missing, created);
  } catch {
    return outcome("failed", [], [], "request_error");
  }
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // A preview or staging deployment holds mirrored production tokens. Refreshing
  // one would rotate the real merchant's token, so require the guard.
  const deployment = process.env.VERCEL_ENV;
  if (deployment && deployment !== "production" && process.env.SHOPIFY_TOKEN_REFRESH_DISABLED !== "true") {
    return NextResponse.json({ error: "token_refresh_guard_required" }, { status: 409 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl) return NextResponse.json({ error: "app_url_not_configured" }, { status: 500 });
  const address = `${appUrl}/api/shopify/webhook`;

  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "true";
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);

  const { data, error } = await supabaseAdmin
    .from("user_integrations")
    .select("clerk_user_id, shopify_store_url, shop_domain")
    .or("shopify_store_url.not.is.null,shop_domain.not.is.null")
    .order("clerk_user_id")
    .range(cursor, cursor + PAGE_SIZE - 1);

  if (error || !data) return NextResponse.json({ error: "integrations_unavailable" }, { status: 500 });

  // Several accounts can share a shop; one healthy token is enough.
  const shops = new Map<string, string[]>();
  for (const row of data) {
    const shop = normalizeHost(row.shop_domain) ?? normalizeHost(row.shopify_store_url);
    if (shop) shops.set(shop, [...(shops.get(shop) ?? []), row.clerk_user_id]);
  }

  const results: ShopOutcome[] = [];
  for (const [shop, userIds] of shops) {
    results.push(await reconcileShop(shop, userIds, address, apply));
  }

  const summary = results.reduce<Record<string, number>>((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, {});

  return NextResponse.json({
    dryRun: !apply,
    summary,
    results,
    nextCursor: data.length === PAGE_SIZE ? cursor + PAGE_SIZE : null,
  });
}
