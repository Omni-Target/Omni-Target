import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { buildMetaTargeting } from "@/lib/meta-targeting";

export async function POST(request: Request) {
  let currentStep = "init";
  
  try {
    const { userId } = await auth();

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      campaignId,
      headline,
      primaryText,
      description,
      cta,
      mediaUrl,
      campaignGoal,
      platform,
      dailyBudget,
      duration,
      locations,
      audienceDescription
    } = body;

    if (!campaignId) {
      return Response.json({ error: "Missing campaignId" }, { status: 400 });
    }

    currentStep = "fetch credentials";
    /**
     * STEP 1 — Fetch user's Meta credentials from Supabase
     * We need the access token to authenticate API calls, the ad account ID
     * to know where to create the assets, and the pixel information to set up
     * the proper conversion tracking for the campaign.
     */
    const { data, error: integrationError } = await 
      supabaseAdmin
        .from("user_integrations")
        .select(
          "meta_access_token, " +
          "meta_ad_account_id, " +
          "meta_pixel_id, " +
          "meta_page_id, " +
          "pixel_health"
        )
        .eq("clerk_user_id", userId)
        .single();

    const integration: any = data;

    if (integrationError || !integration?.meta_access_token) {
      return Response.json(
        { error: "Meta account not connected" },
        { status: 400 }
      );
    }

    const { 
      meta_access_token: accessToken,
      meta_ad_account_id: adAccountId,
      meta_pixel_id: pixelId,
      meta_page_id: pageId,
      pixel_health
    } = integration;

    if (!pageId) {
      return Response.json({
        error: "No Facebook Page connected. " +
        "Please make sure your Meta account " +
        "has a Facebook Page and reconnect.",
      }, { status: 400 });
    }

    /**
     * STEP 2 — Convert budget from Naira to cents
     * Meta requires the budget to be specified in the smallest unit of the
     * billing currency (cents). The ad account is billed in USD, so we convert
     * NGN -> USD -> Cents.
     */
    const NGN_RATE = 1565;
    const dailyBudgetUSD = dailyBudget / NGN_RATE;
    const dailyBudgetCents = Math.round(dailyBudgetUSD * 100);

    // Minimum $1/day
    const finalBudget = Math.max(dailyBudgetCents, 100);

    /**
     * STEP 3 — Map campaign goal to Meta objective
     * This maps the user-friendly goal selected in the UI to the actual 
     * Meta Marketing API OUTCOME_* objective.
     */
    const objectiveMap: Record<string, string> = {
      "Drive Website Sales": "OUTCOME_SALES",
      "Grow Brand Awareness": "OUTCOME_AWARENESS",
      "Promote a New Collection": "OUTCOME_TRAFFIC",
      "Retarget Past Visitors": "OUTCOME_SALES",
      "Grow Instagram Following": "OUTCOME_ENGAGEMENT"
    };

    const objective = pixelId && pixel_health === "healthy"
      ? objectiveMap[campaignGoal] || "OUTCOME_SALES"
      : campaignGoal === "Drive Website Sales"
        ? "OUTCOME_TRAFFIC"
        : objectiveMap[campaignGoal] || "OUTCOME_TRAFFIC";

    /**
     * STEP 4 — API Call 1: Create Ad Creative
     * The Ad Creative contains the actual media (image/video), text, headline,
     * and call-to-action that users will see. It is created unattached and later
     * linked to an Ad.
     */
    currentStep = "creative";
    const creativeRes = await fetch(
      `https://graph.facebook.com/v19.0/` +
      `${adAccountId}/adcreatives`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          name: `Omni-target Creative ${Date.now()}`,
          object_story_spec: {
            page_id: pageId,
            link_data: {
              message: primaryText,
              link: process.env.NEXT_PUBLIC_STORE_URL,
              name: headline,
              description: description,
              call_to_action: {
                type: cta.toUpperCase().replace(/ /g, "_"),
                value: { 
                  link: process.env.NEXT_PUBLIC_STORE_URL 
                }
              },
              ...(mediaUrl && { picture: mediaUrl })
            }
          },
          access_token: accessToken
        })
      }
    );

    const creativeData = await creativeRes.json();
    console.error("Creative error full:", JSON.stringify(creativeData, null, 2));
    if (!creativeData.id) {
      throw creativeData;
    }
    const creativeId = creativeData.id;

    /**
     * STEP 5 — API Call 2: Create Campaign
     * The Campaign houses ad sets and defines the overall objective. It does NOT
     * define targeting or budget. We create it PAUSED to ensure the user can 
     * preview it in Ads Manager before burning budget.
     */
    currentStep = "campaign";
    const campaignRes = await fetch(
      `https://graph.facebook.com/v19.0/` +
      `${adAccountId}/campaigns`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          name: `Omni-target | ${campaignGoal} | ${Date.now()}`,
          objective: objective,
          status: "ACTIVE",
          // Start active directly upon launch
          special_ad_categories: [],
          access_token: accessToken
        })
      }
    );

    const campaignData = await campaignRes.json();
    console.error("Campaign error full:", JSON.stringify(campaignData, null, 2));
    if (!campaignData.id) {
      throw campaignData;
    }
    const metaCampaignId = campaignData.id;

    /**
     * STEP 6 — API Call 3: Create Ad Set
     * The Ad Set determines the budget, schedule, targeting, and optimization.
     * It is created under the Campaign. If the pixel is healthy, we set it as 
     * the promoted_object to optimize for PURCHASES.
     */
    currentStep = "adset";
    const targeting = buildMetaTargeting({
      audienceDescription,
      campaignGoal,
      locations,
      platform,
      pixelHealth: integration.pixel_health || "unknown"
    });

    // Calculate end time if not ongoing
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = duration !== "0" 
      ? startTime + (parseInt(duration) * 24 * 60 * 60)
      : null;

    const adSetBody: any = {
      name: `Omni-target Ad Set | ${Date.now()}`,
      campaign_id: metaCampaignId,
      daily_budget: finalBudget,
      billing_event: "IMPRESSIONS",
      optimization_goal: targeting.optimization_goal,
      targeting: targeting.targeting,
      status: "ACTIVE",
      start_time: startTime,
      access_token: accessToken
    };

    if (endTime) {
      adSetBody.end_time = endTime;
    }

    // Add pixel for conversion tracking only if pixel exists and is verified
    if (pixelId && pixel_health !== "none" && pixel_health !== "unknown") {
      adSetBody.promoted_object = {
        pixel_id: pixelId,
        custom_event_type: "PURCHASE"
      };
    }

    const adSetRes = await fetch(
      `https://graph.facebook.com/v19.0/` +
      `${adAccountId}/adsets`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify(adSetBody)
      }
    );

    const adSetData = await adSetRes.json();
    console.error("AdSet error full:", JSON.stringify(adSetData, null, 2));
    if (!adSetData.id) {
      throw adSetData;
    }
    const adSetId = adSetData.id;

    /**
     * STEP 7 — API Call 4: Create Ad
     * The final step links the Ad Set (targeting/budget) and the Ad Creative.
     * Creating the Ad completes the 4-step sequence.
     */
    currentStep = "ad";
    const adRes = await fetch(
      `https://graph.facebook.com/v19.0/` +
      `${adAccountId}/ads`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          name: `Omni-target Ad | ${Date.now()}`,
          adset_id: adSetId,
          creative: { creative_id: creativeId },
          status: "ACTIVE",
          access_token: accessToken
        })
      }
    );

    const adData = await adRes.json();
    console.error("Ad error full:", JSON.stringify(adData, null, 2));
    if (!adData.id) {
      throw adData;
    }

    /**
     * STEP 8 — Save all Meta IDs to Supabase
     * We persist the references to all created objects so that the app
     * can query their status later or modify them.
     */
    currentStep = "database";
    await supabaseAdmin
      .from("campaigns")
      .update({
        meta_campaign_id: metaCampaignId,
        meta_adset_id: adSetId,
        meta_ad_id: adData.id,
        meta_creative_id: creativeId,
        status: "active",
        launched_at: new Date().toISOString()
      })
      .eq("id", campaignId);

    /**
     * STEP 9 — Return success response
     */
    return Response.json({
      success: true,
      metaCampaignId,
      adSetId,
      adId: adData.id,
      creativeId,
      status: "active",
      message: "Campaign created in Meta Ads Manager. It is currently active and running.",
      metaAdsManagerUrl: 
        `https://www.facebook.com/adsmanager/` +
        `manage/campaigns?act=${adAccountId.replace("act_", "")}`
    }, { status: 200 });

  } catch (err: any) {
    /**
     * STEP 10 — Full error handling
     */
    console.error(`Meta Campaign Launch Error at step: ${currentStep}`, err);
    return Response.json(
      {
        error: "Campaign creation failed",
        step: currentStep,
        details: err instanceof Error ? err.message : err
      },
      { status: 500 }
    );
  }
}
