import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { data } = await
    supabaseAdmin
      .from("user_integrations")
      .select(
        "meta_access_token, " +
        "meta_ad_account_id, " +
        "meta_pixel_id, " +
        "pixel_health"
      )
      .eq("clerk_user_id", userId!)
      .single();

  const integration: any = data;

  if (!integration?.meta_access_token) {
    return Response.json({
      pixelFound: false,
      pixelHealth: "none",
      score: 0,
      issues: ["Meta account not connected"],
      message: "Connect your Meta account first"
    });
  }

  // If no pixel ID stored
  if (!integration.meta_pixel_id) {
    // Update pixel health
    await supabaseAdmin
      .from("user_integrations")
      .update({ pixel_health: "none" })
      .eq("clerk_user_id", userId!);

    return Response.json({
      pixelFound: false,
      pixelHealth: "none",
      score: 10,
      issues: [
        "No Meta Pixel found on your account",
        "Purchase events: not tracking",
        "You are missing attribution on all sales"
      ],
      recommendations: [
        "Install Meta Pixel on your Shopify store",
        "Enable server-side tracking via CAPI"
      ]
    });
  }

  // Pixel exists — check event quality via Meta Graph API
  const eventsRes = await fetch(
    `https://graph.facebook.com/v19.0/` +
    `${integration.meta_pixel_id}/` +
    `stats?aggregation=event_name` +
    `&access_token=${integration.meta_access_token}`
  );

  const eventsData = await eventsRes.json();
  const events = eventsData.data || [];

  const hasPurchase = events.some(
    (e: any) => e.event_name === "Purchase"
  );
  const hasPageView = events.some(
    (e: any) => e.event_name === "PageView"
  );
  const hasAddToCart = events.some(
    (e: any) => e.event_name === "AddToCart"
  );

  const score =
    (hasPageView ? 30 : 0) +
    (hasAddToCart ? 30 : 0) +
    (hasPurchase ? 40 : 0);

  const pixelHealth = score >= 70
    ? "healthy"
    : score >= 30
      ? "broken"
      : "none";

  await supabaseAdmin
    .from("user_integrations")
    .update({ pixel_health: pixelHealth })
    .eq("clerk_user_id", userId!);

  const issues = [];
  const recommendations = [];

  if (!hasPageView) {
    issues.push("PageView not firing");
    recommendations.push(
      "Reinstall your Meta Pixel"
    );
  }
  if (!hasAddToCart) {
    issues.push("AddToCart not tracked");
    recommendations.push(
      "Enable standard events in Meta Pixel"
    );
  }
  if (!hasPurchase) {
    issues.push(
      "Purchase events: 0 in last 30 days"
    );
    recommendations.push(
      "Your ROAS data is inaccurate — " +
      "enable CAPI to fix this"
    );
  }

  return Response.json({
    pixelFound: true,
    pixelId: integration.meta_pixel_id,
    pixelHealth,
    score,
    issues,
    recommendations,
    events: events.map((e: any) => ({
      name: e.event_name,
      count: e.count
    }))
  });
}
