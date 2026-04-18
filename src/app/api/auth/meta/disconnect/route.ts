import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function DELETE() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await supabaseAdmin
      .from("user_integrations")
      .update({
        meta_access_token: null,
        meta_ad_account_id: null,
        meta_pixel_id: null,
        meta_connected_at: null,
        pixel_health: "unknown",
      })
      .eq("clerk_user_id", userId);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Meta disconnect error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
