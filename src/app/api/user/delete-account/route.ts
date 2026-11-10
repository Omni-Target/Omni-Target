import { auth, clerkClient } from "@clerk/nextjs/server";
import { deleteUserData } from "@/lib/db";
import { metaUserTokensForOwner } from "@/modules/credentials/meta";

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
    // Each of this user's own workspaces' Meta grants is revoked; no one else's.
    for (const { userToken } of await metaUserTokensForOwner(userId).catch(() => [])) {
      await fetch(
        `https://graph.facebook.com/v19.0/me/permissions?access_token=${encodeURIComponent(userToken)}`,
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
