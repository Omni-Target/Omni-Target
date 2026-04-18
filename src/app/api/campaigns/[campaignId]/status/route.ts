import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function PATCH(
  request: Request,
  { params }: { 
    params: Promise<{ campaignId: string }> | { campaignId: string }
  }
) {
  // NOTE: Next.js 15+ async params handling required:
  const resolvedParams = await params;
  
  const { userId } = await auth();
  const { action } = await request.json();
  // action: "pause" | "resume" | "stop"

  // Get campaign from Supabase
  const { data: campaign } = await 
    supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("id", resolvedParams.campaignId)
      .eq("clerk_user_id", userId)
      .single();

  if (!campaign) {
    return Response.json(
      { error: "Campaign not found" },
      { status: 404 }
    );
  }

  // Get user's Meta credentials
  const { data: integration } = await 
    supabaseAdmin
      .from("user_integrations")
      .select(
        "meta_access_token, meta_ad_account_id"
      )
      .eq("clerk_user_id", userId)
      .single();

  const statusMap = {
    pause: "PAUSED",
    resume: "ACTIVE",
    stop: "DELETED"
  };

  const metaStatus = 
    statusMap[action as keyof typeof statusMap];

  // Update campaign status in Meta
  await fetch(
    `https://graph.facebook.com/v19.0/${campaign.meta_campaign_id}`,
    {
      method: "POST",
      headers: { 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        status: metaStatus,
        access_token: integration?.meta_access_token
      })
    }
  );

  // Update in Supabase
  const newStatus = action === "stop" 
    ? "stopped" 
    : action === "pause" 
      ? "paused" 
      : "active";

  await supabaseAdmin
    .from("campaigns")
    .update({ status: newStatus })
    .eq("id", resolvedParams.campaignId);

  return Response.json({ 
    success: true, 
    status: newStatus 
  });
}
