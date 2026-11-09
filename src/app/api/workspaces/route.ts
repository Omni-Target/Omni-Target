import { NextResponse } from "next/server";
import { signedInUser, unauthorized, workspaceErrorResponse } from "@/modules/workspaces/http";
import { listWorkspaces } from "@/modules/workspaces/repository";

export const dynamic = "force-dynamic";

/** The signed-in user's workspaces and the store each one holds. */
export async function GET() {
  const userId = await signedInUser();
  if (!userId) return unauthorized();
  try {
    return NextResponse.json({ workspaces: await listWorkspaces(userId) });
  } catch (error) {
    return workspaceErrorResponse(error, "List workspaces");
  }
}
