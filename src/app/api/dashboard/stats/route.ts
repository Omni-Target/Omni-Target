import { auth } from "@clerk/nextjs/server";
import { getUserIntegration, getUserCampaigns } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Get user's Meta credentials
  const integration = await getUserIntegration(userId);
  const dbError = !integration ? new Error("Integration not found") : null;

  console.log("Dashboard stats - userId:", userId);
  console.log("Integration found:", !!integration);
  console.log("Has token:", !!integration?.meta_access_token);
  console.log("DB error:", dbError);

  if (!integration?.meta_access_token) {
    return Response.json({ 
      connected: false,
      message: "Meta account not connected"
    });
  }

  const { 
    meta_access_token: accessToken,
    meta_ad_account_id: adAccountId 
  } = integration;

  // Fetch campaign insights from Meta
  // Last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(
    thirtyDaysAgo.getDate() - 30
  );
  const dateFrom = thirtyDaysAgo
    .toISOString().split("T")[0];
  const dateTo = new Date()
    .toISOString().split("T")[0];

  const insightsRes = await fetch(
    `https://graph.facebook.com/v19.0/` +
    `${adAccountId}/insights?` +
    `fields=campaign_name,spend,` +
    `impressions,clicks,actions,` +
    `cost_per_action_type,ctr,cpc,` +
    `campaign_id` +
    `&time_range={"since":"${dateFrom}",` +
    `"until":"${dateTo}"}` +
    `&level=campaign` +
    `&limit=10` +
    `&access_token=${accessToken}`
  );

  const insightsData = await insightsRes.json();

  if (insightsData.error) {
    console.error(
      "Meta insights error:", 
      insightsData.error
    );
    return Response.json({
      connected: true,
      error: "Failed to fetch Meta data",
      details: insightsData.error
    }, { status: 500 });
  }

  // Get campaigns from database layer too
  const activeCampaigns = await getUserCampaigns(userId);

  // Calculate FX-adjusted totals
  const NGN_RATE = 1565;
  
  const totalSpendUSD = 
    insightsData.data?.reduce(
      (sum: number, c: any) => 
        sum + parseFloat(c.spend || 0), 
      0
    ) || 0;

  const totalSpendNGN = 
    totalSpendUSD * NGN_RATE;

  const totalPurchases = 
    insightsData.data?.reduce(
      (sum: number, c: any) => {
        const purchases = 
          c.actions?.find(
            (a: any) => 
              a.action_type === "purchase"
          );
        return sum + 
          parseFloat(purchases?.value || 0);
      }, 
      0
    ) || 0;

  const totalImpressions = 
    insightsData.data?.reduce(
      (sum: number, c: any) => 
        sum + 
        parseInt(c.impressions || 0), 
      0
    ) || 0;

  const totalClicks = 
    insightsData.data?.reduce(
      (sum: number, c: any) => 
        sum + parseInt(c.clicks || 0), 
      0
    ) || 0;

  return Response.json({
    connected: true,
    dateRange: { from: dateFrom, to: dateTo },
    summary: {
      totalSpendUSD: 
        totalSpendUSD.toFixed(2),
      totalSpendNGN: 
        Math.round(totalSpendNGN),
      totalPurchases,
      totalImpressions,
      totalClicks,
      averageCTR: totalImpressions > 0 
        ? ((totalClicks / totalImpressions) * 100).toFixed(2)
        : "0.00",
      fxRate: NGN_RATE,
    },
    campaigns: insightsData.data || [],
    activeCampaigns: activeCampaigns || []
  });
}
