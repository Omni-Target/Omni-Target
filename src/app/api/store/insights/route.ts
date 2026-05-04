import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { generateRecommendations } from "@/lib/insights-engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    // Get cached store snapshot
    const { data: integration } = await supabaseAdmin
      .from("user_integrations")
      .select("store_snapshot")
      .eq("clerk_user_id", userId)
      .single();

    if (!integration?.store_snapshot) {
      return Response.json({
        error: "No store data available. Sync your store first.",
      }, { status: 400 });
    }

    const recommendations = await generateRecommendations(
      integration.store_snapshot
    );

    return Response.json(recommendations);
  } catch (error) {
    console.error("Insights generation error:", error);
    return Response.json(
      { error: "Failed to generate insights" },
      { status: 500 }
    );
  }
}
