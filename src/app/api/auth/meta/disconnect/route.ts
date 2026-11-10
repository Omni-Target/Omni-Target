import { auth } from "@clerk/nextjs/server";
import { updateUserIntegration } from "@/lib/db";
import { NextResponse } from "next/server";
import { clearMetaConnection } from "@/modules/credentials/meta";
import { currentWorkspaceFor } from "@/modules/workspaces/current";

/**
 * Disconnects Meta from the workspace the user is working in (task 4): its
 * encrypted credentials and asset selection are deleted. Other workspaces the
 * user owns keep their own Meta connections.
 */
export async function DELETE() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspace = await currentWorkspaceFor(userId);
    if (workspace) await clearMetaConnection(workspace.workspace_id, userId);

    await updateUserIntegration(userId, {
      meta_access_token: null,
      meta_ad_account_id: null,
      meta_pixel_id: null,
      meta_connected_at: null,
      pixel_health: "unknown",
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Meta disconnect error:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
