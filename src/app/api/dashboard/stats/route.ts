import { getUserIntegration, getUserCampaigns } from "@/lib/db";
import { getUsdRate } from "@/lib/exchange-rates";
import { fetchWithRetry } from "@/lib/http";
import { requireUser } from "@/lib/api/require-user";
import { createLogger } from "@/lib/logger";
import type { MetaInsight, MetaInsightsResponse } from "@/lib/types/meta";

export const dynamic = "force-dynamic";

const log = createLogger("dashboard-stats");

const num = (value: string | undefined): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function GET() {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  const integration = await getUserIntegration(userId);

  if (!integration?.meta_access_token) {
    return Response.json({
      connected: false,
      message: "Meta account not connected",
    });
  }

  const {
    meta_access_token: accessToken,
    meta_ad_account_id: adAccountId,
  } = integration;

  // Last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateFrom = thirtyDaysAgo.toISOString().split("T")[0];
  const dateTo = new Date().toISOString().split("T")[0];

  // Fetch every campaign in the window by following Meta's paging cursors — the
  // old hardcoded `limit=10` silently truncated both the campaign list and the
  // aggregate totals for accounts with more than ten campaigns. Page size is
  // raised and the walk is capped so a pathological account can't run unbounded.
  const firstUrl =
    `https://graph.facebook.com/v19.0/${adAccountId}/insights?` +
    `fields=campaign_name,spend,impressions,clicks,actions,` +
    `cost_per_action_type,ctr,cpc,campaign_id` +
    `&time_range={"since":"${dateFrom}","until":"${dateTo}"}` +
    `&level=campaign&limit=100&access_token=${accessToken}`;

  const MAX_PAGES = 10;
  const insights: MetaInsight[] = [];
  try {
    let nextUrl: string | undefined = firstUrl;
    for (let page = 0; nextUrl && page < MAX_PAGES; page++) {
      const res = await fetchWithRetry(nextUrl);
      const json = (await res.json()) as MetaInsightsResponse;
      if (json.error) {
        // Log full provider error server-side; never return it to the client.
        log.error("Meta insights error", json.error);
        return Response.json(
          { connected: true, error: "Failed to fetch Meta data" },
          { status: 502 },
        );
      }
      if (json.data?.length) insights.push(...json.data);
      nextUrl = json.paging?.next;
    }
  } catch (error) {
    log.error("Meta insights request failed", error);
    return Response.json(
      { connected: true, error: "Failed to fetch Meta data" },
      { status: 502 },
    );
  }
  // Independent reads — run them together rather than waterfalling.
  const [activeCampaigns, ngnRate] = await Promise.all([
    getUserCampaigns(userId),
    getUsdRate("NGN"),
  ]);

  const totalSpendUSD = insights.reduce((sum, c) => sum + num(c.spend), 0);
  const totalSpendNGN = totalSpendUSD * ngnRate;
  const totalPurchases = insights.reduce((sum, c) => {
    const purchase = c.actions?.find((a) => a.action_type === "purchase");
    return sum + num(purchase?.value);
  }, 0);
  const totalImpressions = insights.reduce(
    (sum, c) => sum + num(c.impressions),
    0,
  );
  const totalClicks = insights.reduce((sum, c) => sum + num(c.clicks), 0);

  return Response.json({
    connected: true,
    dateRange: { from: dateFrom, to: dateTo },
    summary: {
      totalSpendUSD: totalSpendUSD.toFixed(2),
      totalSpendNGN: Math.round(totalSpendNGN),
      totalPurchases,
      totalImpressions,
      totalClicks,
      averageCTR:
        totalImpressions > 0
          ? ((totalClicks / totalImpressions) * 100).toFixed(2)
          : "0.00",
      fxRate: Math.round(ngnRate),
    },
    campaigns: insights,
    activeCampaigns: activeCampaigns || [],
  });
}
