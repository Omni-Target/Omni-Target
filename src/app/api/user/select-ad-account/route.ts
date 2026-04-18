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

  const { adAccountId } = await request.json();

  await supabaseAdmin
    .from("user_integrations")
    .update({ 
      meta_selected_account_id: adAccountId,
      meta_ad_account_id: adAccountId
    })
    .eq("clerk_user_id", userId);

  return Response.json({ success: true });
}
