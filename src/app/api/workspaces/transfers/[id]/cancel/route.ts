import { NextResponse } from "next/server";
import { uuidOrNull } from "@/lib/shopify-oauth";
import { notFound, signedInUser, unauthorized, workspaceErrorResponse } from "@/modules/workspaces/http";
import { cancelOwnershipTransfer } from "@/modules/workspaces/repository";

export const dynamic = "force-dynamic";

/** The requester or the store's current owner withdraws an open transfer. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await signedInUser();
  if (!userId) return unauthorized();
  const transferId = uuidOrNull((await params).id);
  if (!transferId) return notFound();
  try {
    return NextResponse.json(await cancelOwnershipTransfer(transferId, userId));
  } catch (error) {
    return workspaceErrorResponse(error, "Cancel transfer");
  }
}
