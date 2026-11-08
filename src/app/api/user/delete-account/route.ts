import { auth, clerkClient } from "@clerk/nextjs/server";
import { deleteUserData, getUserIntegration } from "@/lib/db";

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
    // Best effort: stored tokens are deleted below whether or not Meta answers.
    // Only this user's own connection is revoked, never a shared shop's.
    const integration = await getUserIntegration(userId);
    if (integration?.meta_access_token) {
      await fetch(
        `https://graph.facebook.com/v19.0/me/permissions?access_token=${encodeURIComponent(integration.meta_access_token)}`,
        { method: "DELETE", signal: AbortSignal.timeout(5000) },
      ).catch(() => {});
    }

    await deleteUserData(userId);

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
