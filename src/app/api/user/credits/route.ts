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

  const { data } = await supabaseAdmin
    .from("user_integrations")
    .select("credits_balance, credits_unlimited_until")
    .eq("clerk_user_id", userId)
    .single();

  const isUnlimited =
    data?.credits_unlimited_until &&
    new Date(data.credits_unlimited_until) > new Date();

  return Response.json({
    credits_balance: data?.credits_balance || 0,
    is_unlimited: !!isUnlimited,
    unlimited_until: data?.credits_unlimited_until || null,
  });
}
