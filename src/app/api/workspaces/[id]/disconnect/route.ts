import { NextResponse } from "next/server";
import { disconnectShopInstallation } from "@/lib/db";
import { uuidOrNull } from "@/lib/shopify-oauth";
import { notFound, signedInUser, unauthorized, workspaceErrorResponse } from "@/modules/workspaces/http";
import { disconnectWorkspace } from "@/modules/workspaces/repository";

export const dynamic = "force-dynamic";

/**
 * The owner disconnects a workspace's store: Shopify work stops and the stored
 * credential is cleared. The workspace keeps the store, its data and credits;
 * reconnecting the same store restores it, and no other account can claim it.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await signedInUser();
  if (!userId) return unauthorized();
  const workspaceId = uuidOrNull((await params).id);
  if (!workspaceId) return notFound();

  try {
    const result = await disconnectWorkspace(workspaceId, userId);
    const disconnected = result.outcome === "disconnected" || result.status === "disconnected";
    // Repeating the request finishes a credential clear that failed before.
    if (disconnected && result.shop_domain && !(await disconnectShopInstallation(result.shop_domain))) {
      throw new Error("credentials_not_cleared");
    }
    return NextResponse.json({ outcome: result.outcome, status: result.status ?? "disconnected" });
  } catch (error) {
    return workspaceErrorResponse(error, "Disconnect workspace");
  }
}
