import { NextResponse } from "next/server";
import { z } from "zod";
import { isValidShopDomain } from "@/lib/shopify-oauth";
import { badRequest, signedInUser, unauthorized, workspaceErrorResponse } from "@/modules/workspaces/http";
import { listTransfersForActor, requestOwnershipTransfer } from "@/modules/workspaces/repository";

export const dynamic = "force-dynamic";

const TransferRequest = z.object({
  shop: z.string().trim().toLowerCase().max(255),
  reason: z.string().trim().max(500).optional(),
  workspaceId: z.uuid().optional(),
});

/** Transfers the signed-in user requested, and requests for stores they own. */
export async function GET() {
  const userId = await signedInUser();
  if (!userId) return unauthorized();
  try {
    return NextResponse.json({ transfers: await listTransfersForActor(userId) });
  } catch (error) {
    return workspaceErrorResponse(error, "List transfers");
  }
}

/**
 * Asks for a store held by another account. The requester then proves control
 * of the store through Shopify (verifyUrl), the current owner approves, and the
 * requester completes it with their own installation. Credits, campaigns and
 * billing history never move.
 */
export async function POST(request: Request) {
  const userId = await signedInUser();
  if (!userId) return unauthorized();

  const parsed = TransferRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isValidShopDomain(parsed.data.shop)) return badRequest("invalid_request");

  try {
    const { transfer_id: transferId } = await requestOwnershipTransfer({
      domain: parsed.data.shop,
      requester: userId,
      targetWorkspaceId: parsed.data.workspaceId ?? null,
      reason: parsed.data.reason || null,
    });
    const verifyUrl = `/api/auth/shopify/connect?${new URLSearchParams({ shop: parsed.data.shop, from: "dashboard", transfer: transferId })}`;
    return NextResponse.json({ transferId, verifyUrl }, { status: 201 });
  } catch (error) {
    return workspaceErrorResponse(error, "Request transfer");
  }
}
