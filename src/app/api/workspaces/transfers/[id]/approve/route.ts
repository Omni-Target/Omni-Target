import { NextResponse } from "next/server";
import { uuidOrNull } from "@/lib/shopify-oauth";
import { notFound, signedInUser, unauthorized, workspaceErrorResponse } from "@/modules/workspaces/http";
import { approveOwnershipTransfer } from "@/modules/workspaces/repository";

export const dynamic = "force-dynamic";

/**
 * The store's current owner approves a transfer the requester has verified
 * through Shopify. Nothing moves until the requester completes it with their
 * own installation.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await signedInUser();
  if (!userId) return unauthorized();
  const transferId = uuidOrNull((await params).id);
  if (!transferId) return notFound();
  try {
    return NextResponse.json(await approveOwnershipTransfer(transferId, userId));
  } catch (error) {
    return workspaceErrorResponse(error, "Approve transfer");
  }
}
