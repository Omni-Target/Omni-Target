import { getUserIntegration, getUserCampaigns } from "@/lib/db";
import { getUsdRate } from "@/lib/exchange-rates";
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

  let insightsData: MetaInsightsResponse;
  try {
    const insightsRes = await fetch(
      `https://graph.facebook.com/v19.0/${adAccountId}/insights?` +
        `fields=campaign_name,spend,impressions,clicks,actions,` +
        `cost_per_action_type,ctr,cpc,campaign_id` +
        `&time_range={"since":"${dateFrom}","until":"${dateTo}"}` +
        `&level=campaign&limit=10&access_token=${accessToken}`,
    );
    insightsData = (await insightsRes.json()) as MetaInsightsResponse;
  } catch (error) {
    log.error("Meta insights request failed", error);
    return Response.json(
      { connected: true, error: "Failed to fetch Meta data" },
      { status: 502 },
    );
  }

  if (insightsData.error) {
    // Log full provider error server-side; never return it to the client.
    log.error("Meta insights error", insightsData.error);
    return Response.json(
      { connected: true, error: "Failed to fetch Meta data" },
      { status: 502 },
    );
  }

  const insights: MetaInsight[] = insightsData.data ?? [];
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
