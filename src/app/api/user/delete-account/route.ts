import { auth, clerkClient } from "@clerk/nextjs/server";
import { deleteUserCampaigns, deleteUserCapiEvents, deleteUserIntegration } from "@/lib/db";

export async function DELETE() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    // Delete all user data from database layer
    await deleteUserCampaigns(userId);
    await deleteUserCapiEvents(userId);
    await deleteUserIntegration(userId);

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
