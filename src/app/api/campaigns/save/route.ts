import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const body = await request.json();

  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .insert({
      clerk_user_id: userId,
      brand_name: body.brandName,
      product_name: body.productName,
      product_description: body.productDescription,
      target_audience: body.targetAudience,
      campaign_goal: body.campaignGoal,
      tone_preference: body.tonePreference,
      platform: body.platform,
      media_url: body.mediaUrl || null,
      headline: body.headline,
      primary_text: body.primaryText,
      description: body.description,
      cta: body.cta,
      copywriter_note: body.copywriterNote,
      status: "draft"
    })
    .select()
    .single();

  if (error) {
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }

  return Response.json({ 
    campaignId: data.id 
  });
}
