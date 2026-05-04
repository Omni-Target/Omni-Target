import { auth, clerkClient } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function DELETE() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    // Delete all user data from Supabase
    await supabaseAdmin
      .from("campaigns")
      .delete()
      .eq("clerk_user_id", userId);

    await supabaseAdmin
      .from("capi_events")
      .delete()
      .eq("clerk_user_id", userId);

    await supabaseAdmin
      .from("user_integrations")
      .delete()
      .eq("clerk_user_id", userId);

    // Delete from Clerk
    const client = await clerkClient();
    await client.users.deleteUser(userId);

    return Response.json({ 
      success: true 
    });

  } catch (error) {
    console.error(
      "Account deletion error:", error
    );
    return Response.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }
}
