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

  const { meta_page_id, meta_page_name } = await request.json();

  await supabaseAdmin
    .from("user_integrations")
    .update({ 
      meta_page_id,
      meta_page_name
    })
    .eq("clerk_user_id", userId);

  return Response.json({ success: true });
}
